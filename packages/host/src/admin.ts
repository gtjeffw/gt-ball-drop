import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import {
  AdminUiToHostSchema,
  PeerMessageSchema,
  type AdminHostToUi,
  type ControlCommand,
  type EventEnvelope,
  type ExperimentStatus,
  type PeerMessage,
  type PeerSummary,
} from '@gtbd/protocol';
import { handshake, pairingIdFor, parsePairingCode, TokenPairing, webSocketDuplex, type SecureChannel, type WebSocketLike } from '@gtbd/secure';
import { SessionFiles } from '@gtbd/sinks/node';
import { ControlFeed, type ControlBackend } from './control-api';
import type { StateFile } from './state';

const PING_EVERY_MS = 10_000;
const RECONNECT_MS = 2_000;

export interface AdminHostOptions {
  dataDir: string;
  state: StateFile;
  log: (msg: string) => void;
}

/**
 * The admin machine's host. It dials the participant host, keeps a mirror copy of every
 * session, relays the admin UI's commands, and measures the clock offset between the two
 * machines.
 */
export class AdminHost implements ControlBackend {
  private readonly uiClients = new Set<WebSocket>();
  private channel: SecureChannel | null = null;
  private peer: PeerSummary = { address: '', state: 'disconnected', peerId: null, error: null, clock: null };
  private latestStatus: ExperimentStatus | null = null;
  private mirror: SessionFiles | null = null;
  private readonly mirrors = new Map<string, SessionFiles>();
  private readonly mirrorRoot: string;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private wantConnected = false;
  private readonly feed = new ControlFeed();

  constructor(private readonly opts: AdminHostOptions) {
    this.mirrorRoot = path.join(opts.dataDir, 'mirror');
    fs.mkdirSync(this.mirrorRoot, { recursive: true });
  }

  get peerSummary(): PeerSummary {
    return this.peer;
  }

  // ---- control API backend (a program on this machine, forwarded over the peer link) -----

  get connected(): boolean {
    return this.channel !== null;
  }

  get status(): ExperimentStatus | null {
    return this.latestStatus;
  }

  send(command: ControlCommand): string | null {
    if (!this.channel) return 'Not connected to the participant machine';
    void this.channel.send({ t: 'cmd', command, source: 'control-api' } satisfies PeerMessage);
    return null;
  }

  subscribe(listener: Parameters<ControlBackend['subscribe']>[0]): () => void {
    return this.feed.subscribe(listener);
  }

  handleUi(ws: WebSocket): void {
    this.uiClients.add(ws);
    this.opts.log(`Admin page connected (${this.uiClients.size} open)`);
    ws.on('close', () => this.uiClients.delete(ws));
    const knownPeers = this.opts.state.state.pairings.map((p) => p.address).filter((a): a is string => !!a);
    this.sendUi(ws, { t: 'hello', role: 'admin', hostId: this.opts.state.state.hostId, knownPeers });
    this.sendUi(ws, { t: 'peer', peer: this.peer });
    this.sendUi(ws, { t: 'status', status: this.latestStatus });
    if (this.mirror) this.sendUi(ws, { t: 'mirror', mirror: this.mirrorSummary(this.mirror) });

    ws.on('message', (raw) => {
      const parsed = AdminUiToHostSchema.safeParse(safeJson(String(raw)));
      if (!parsed.success) {
        this.sendUi(ws, { t: 'error', message: 'bad message' });
        return;
      }
      const msg = parsed.data;
      if (msg.t === 'connect') void this.connect(msg.address, msg.pairingCode);
      else if (msg.t === 'disconnect') this.disconnect();
      else if (msg.t === 'cmd') {
        if (!this.channel) this.sendUi(ws, { t: 'error', message: 'Not connected to the participant machine' });
        else void this.channel.send({ t: 'cmd', command: msg.command, source: 'admin-panel' } satisfies PeerMessage);
      }
    });
  }

  /** Connect to a participant host at "host:port". A new code replaces the stored one for that address. */
  async connect(address: string, pairingCode?: string): Promise<void> {
    this.disconnect();
    const st = this.opts.state;
    let code = pairingCode?.trim();
    if (code) {
      const secret = parsePairingCode(code);
      if (!secret) return this.setPeer({ address, state: 'error', error: 'That pairing code is not valid (expected 26 characters)' });
      const pairingId = await pairingIdFor(secret);
      st.state.pairings = st.state.pairings.filter((p) => p.address !== address);
      st.state.pairings.push({ pairingId, code, address, peerNodeId: null, createdAt: new Date().toISOString(), lastUsedAt: null });
      st.save();
    } else {
      code = st.state.pairings.find((p) => p.address === address)?.code;
      if (!code) return this.setPeer({ address, state: 'error', error: 'Enter the pairing code shown on the participant machine' });
    }
    this.wantConnected = true;
    await this.dial(address, code);
  }

  disconnect(): void {
    this.wantConnected = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.channel?.close('admin disconnected');
    this.channel = null;
    if (this.peer.state !== 'disconnected') this.setPeer({ state: 'disconnected', error: null });
  }

  private async dial(address: string, code: string): Promise<void> {
    this.setPeer({ address, state: 'connecting', error: null, peerId: null });
    const url = `ws://${address}/peer`;
    const ws = new WebSocket(url);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', (e) => reject(e));
      });
    } catch (err) {
      this.setPeer({ state: 'error', error: `Cannot reach ${address}: ${(err as Error).message}` });
      this.scheduleReconnect(address, code);
      return;
    }
    this.setPeer({ state: 'handshaking' });
    let result;
    try {
      result = await handshake({
        duplex: webSocketDuplex(ws as unknown as WebSocketLike),
        role: 'initiator',
        nodeId: this.opts.state.state.hostId,
        strategies: [new TokenPairing({ role: 'initiator', code })],
      });
    } catch (err) {
      // Pairing errors are final: don't retry a code the participant rejected.
      this.wantConnected = false;
      this.setPeer({ state: 'error', error: (err as Error).message });
      return;
    }
    const rec = this.opts.state.state.pairings.find((p) => p.address === address);
    if (rec) {
      rec.peerNodeId = result.peerNodeId;
      rec.lastUsedAt = new Date().toISOString();
      this.opts.state.save();
    }
    this.channel = result.channel;
    this.setPeer({ state: 'connected', peerId: result.peerNodeId, error: null });
    this.opts.log(`Connected to participant ${result.peerNodeId} at ${address}`);

    const ch = result.channel;
    ch.onMessage((raw) => {
      const parsed = PeerMessageSchema.safeParse(raw);
      if (parsed.success) this.handlePeerMessage(ch, parsed.data as PeerMessage);
    });
    ch.onClose((reason) => {
      if (this.channel !== ch) return;
      this.channel = null;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.opts.log(`Participant link closed: ${reason}`);
      this.setPeer({ state: this.wantConnected ? 'connecting' : 'disconnected', error: this.wantConnected ? reason : null });
      this.scheduleReconnect(address, code);
    });
    this.ping();
    this.pingTimer = setInterval(() => this.ping(), PING_EVERY_MS);
  }

  private scheduleReconnect(address: string, code: string): void {
    if (!this.wantConnected || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.wantConnected && !this.channel) void this.dial(address, code);
    }, RECONNECT_MS);
  }

  private ping(): void {
    void this.channel?.send({ t: 'ping', t0: Date.now() } satisfies PeerMessage);
  }

  private handlePeerMessage(ch: SecureChannel, msg: PeerMessage): void {
    switch (msg.t) {
      case 'status':
        this.latestStatus = msg.status;
        this.broadcastUi({ t: 'status', status: msg.status });
        this.feed.status(msg.status);
        break;
      case 'session': {
        let sf = this.mirrors.get(msg.sessionId) ?? this.findMirror(msg.sessionId);
        if (!sf) {
          sf = SessionFiles.create(
            this.mirrorRoot,
            { sessionId: msg.sessionId, participantId: msg.participantId, startedAt: msg.startedAt, appVersion: msg.appVersion, copy: 'mirror' },
            null,
          );
          this.opts.log(`Mirroring session ${msg.sessionId} -> ${sf.dir}`);
        }
        this.mirrors.set(msg.sessionId, sf);
        this.mirror = sf;
        void ch.send({ t: 'sync', sessionId: msg.sessionId, lastSeq: sf.lastSeq } satisfies PeerMessage);
        this.broadcastUi({ t: 'mirror', mirror: this.mirrorSummary(sf) });
        break;
      }
      case 'events': {
        const sf = this.mirrors.get(msg.sessionId);
        if (!sf) return;
        const before = sf.lastSeq;
        const seq = sf.append(msg.events as EventEnvelope[]);
        void ch.send({ t: 'ack', sessionId: msg.sessionId, seq } satisfies PeerMessage);
        const fresh = (msg.events as EventEnvelope[]).filter((e) => e.seq > before && e.seq <= seq);
        for (const e of fresh) this.broadcastUi({ t: 'event', envelope: e });
        this.feed.events(fresh);
        this.broadcastUi({ t: 'mirror', mirror: this.mirrorSummary(sf) });
        break;
      }
      case 'pong': {
        // NTP-style estimate: participant clock minus admin clock, assuming symmetric delay.
        const t2 = Date.now();
        const rttMs = t2 - msg.t0;
        const offsetMs = msg.t1 - (msg.t0 + rttMs / 2);
        this.setPeer({ clock: { offsetMs, rttMs } });
        void ch.send({ t: 'clock', offsetMs, rttMs } satisfies PeerMessage);
        break;
      }
      default:
        break;
    }
  }

  private findMirror(sessionId: string): SessionFiles | null {
    for (const name of fs.readdirSync(this.mirrorRoot)) {
      const metaPath = path.join(this.mirrorRoot, name, 'session.json');
      try {
        if (fs.existsSync(metaPath) && JSON.parse(fs.readFileSync(metaPath, 'utf8')).sessionId === sessionId) {
          return SessionFiles.open(path.join(this.mirrorRoot, name));
        }
      } catch {
        /* skip */
      }
    }
    return null;
  }

  private mirrorSummary(sf: SessionFiles) {
    return { sessionId: sf.meta.sessionId, participantId: sf.meta.participantId, lastSeq: sf.lastSeq, dir: sf.dir };
  }

  private setPeer(patch: Partial<PeerSummary>): void {
    this.peer = { ...this.peer, ...patch };
    this.broadcastUi({ t: 'peer', peer: this.peer });
  }

  private sendUi(ws: WebSocket, msg: AdminHostToUi): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  private broadcastUi(msg: AdminHostToUi): void {
    for (const ws of this.uiClients) this.sendUi(ws, msg);
  }

  close(): void {
    this.disconnect();
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const sf of this.mirrors.values()) sf.close();
    this.mirrors.clear();
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
