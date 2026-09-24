import type { EventEnvelope, ExperimentConfig, GameToHost, HostToGame } from '@gtbd/protocol';
import type { ReplicationTarget } from '@gtbd/sinks';

export interface SessionInfo {
  sessionId: string;
  participantId: string;
  version: string;
  startedAt: string;
  config: ExperimentConfig;
}

const SESSION_KEY = (id: string) => `gtbd.session.${id}`;

/**
 * The game page's link to the participant host on the same machine. It reconnects on
 * failure, and it doubles as the outbox's ReplicationTarget: events go to the host, the
 * host fsyncs and acks, and only then does the outbox drop them.
 */
export class HostLink {
  readonly name = 'participant-host';
  private ws: WebSocket | null = null;
  private helloMsg: Extract<HostToGame, { t: 'hello' }> | null = null;
  private readonly handlers = new Set<(m: HostToGame) => void>();
  private ackCb: (sessionId: string, seq: number) => void = () => {};
  private readyCb: () => void = () => {};
  private openedThisConnection = new Set<string>();
  private retryMs = 500;

  constructor(private readonly url: string) {}

  get ready(): boolean {
    return this.helloMsg !== null && this.ws?.readyState === WebSocket.OPEN;
  }

  get hello() {
    return this.helloMsg;
  }

  /** Connect, and resolve with the host's hello, or null if there's no host within timeoutMs. */
  start(timeoutMs = 1500): Promise<Extract<HostToGame, { t: 'hello' }> | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      const off = this.on((m) => {
        if (m.t === 'hello') {
          clearTimeout(timer);
          off();
          resolve(m);
        }
      });
      this.connect();
    });
  }

  on(handler: (m: HostToGame) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  send(msg: GameToHost): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  /** Remember a session's metadata, so it can be (re)opened on the host from the outbox. */
  registerSession(info: SessionInfo): void {
    localStorage.setItem(SESSION_KEY(info.sessionId), JSON.stringify(info));
    this.ensureOpened(info.sessionId);
  }

  // ---- outbox replication (see hostTarget below) -------------------------------------------

  sendEvents(sessionId: string, events: EventEnvelope[]): void {
    if (!this.ensureOpened(sessionId)) return;
    this.send({ t: 'events', sessionId, events });
  }

  onAck(cb: (sessionId: string, seq: number) => void): void {
    this.ackCb = cb;
  }

  onReady(cb: () => void): void {
    this.readyCb = cb;
  }

  private ensureOpened(sessionId: string): boolean {
    if (this.openedThisConnection.has(sessionId)) return true;
    const raw = localStorage.getItem(SESSION_KEY(sessionId));
    if (!raw) return false;
    const info = JSON.parse(raw) as SessionInfo;
    if (!this.send({ t: 'session.open', ...info })) return false;
    this.openedThisConnection.add(sessionId);
    return true;
  }

  private connect(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data)) as HostToGame;
      if (m.t === 'hello') {
        this.helloMsg = m;
        this.retryMs = 500;
        this.openedThisConnection = new Set();
        queueMicrotask(() => this.readyCb());
      }
      if (m.t === 'ack') this.ackCb(m.sessionId, m.seq);
      for (const h of this.handlers) h(m);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.helloMsg = null;
      setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 5000);
    };
  }
}

/** Adapter so the Replicator sees the ReplicationTarget shape without clashing with HostLink.send(). */
export function hostTarget(link: HostLink): ReplicationTarget {
  return {
    name: link.name,
    get ready() {
      return link.ready;
    },
    send: (sessionId, events) => link.sendEvents(sessionId, events),
    onAck: (cb) => link.onAck(cb),
    onReady: (cb) => link.onReady(cb),
  };
}
