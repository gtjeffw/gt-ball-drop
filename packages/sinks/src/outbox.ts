import type { EventEnvelope } from '@gtbd/protocol';

/**
 * Storage for events not yet acknowledged by a downstream sink. The outbox is what makes
 * capture "local first": every event is kept durably on the capturing machine, then
 * replicated to one or more targets (the local host's files today, a cloud API later).
 * An event leaves the outbox only after every target has acknowledged it.
 */
export interface OutboxStore {
  put(envelopes: EventEnvelope[]): Promise<void>;
  /** Events for a session with seq > afterSeq, in seq order. */
  after(sessionId: string, afterSeq: number, limit: number): Promise<EventEnvelope[]>;
  /** Delete events with seq <= upToSeq. */
  trim(sessionId: string, upToSeq: number): Promise<void>;
  sessions(): Promise<string[]>;
}

export class MemoryOutboxStore implements OutboxStore {
  private readonly bySession = new Map<string, EventEnvelope[]>();

  async put(envelopes: EventEnvelope[]): Promise<void> {
    for (const e of envelopes) {
      const list = this.bySession.get(e.sessionId) ?? [];
      if (!list.length || list[list.length - 1]!.seq < e.seq) list.push(e);
      this.bySession.set(e.sessionId, list);
    }
  }

  async after(sessionId: string, afterSeq: number, limit: number): Promise<EventEnvelope[]> {
    return (this.bySession.get(sessionId) ?? []).filter((e) => e.seq > afterSeq).slice(0, limit);
  }

  async trim(sessionId: string, upToSeq: number): Promise<void> {
    const list = this.bySession.get(sessionId);
    if (!list) return;
    const kept = list.filter((e) => e.seq > upToSeq);
    if (kept.length) this.bySession.set(sessionId, kept);
    else this.bySession.delete(sessionId);
  }

  async sessions(): Promise<string[]> {
    return [...this.bySession.keys()];
  }
}

/**
 * A downstream destination. It receives batches and acknowledges the highest contiguous
 * seq it has durably stored. It must be idempotent: resending events it already has is
 * normal after a reconnect.
 */
export interface ReplicationTarget {
  readonly name: string;
  /** True when a batch can be sent right now (e.g. the socket is open). */
  readonly ready: boolean;
  send(sessionId: string, events: EventEnvelope[]): void;
  /** Register the ack handler. Targets call it with the highest durable seq. */
  onAck(cb: (sessionId: string, seq: number) => void): void;
  /** Register for "became ready" (reconnected): replication resumes from the last ack. */
  onReady(cb: () => void): void;
}

export interface ReplicatorOptions {
  batchSize?: number;
  /** Resend unacknowledged events after this long (ms). */
  resendAfterMs?: number;
}

/**
 * Pumps outbox events to targets, tracking each target's acknowledged seq. It keeps at
 * most one batch in flight per target, and resends on reconnect or timeout.
 */
export class Replicator {
  private readonly acked = new Map<ReplicationTarget, Map<string, number>>();
  private readonly inFlight = new Map<ReplicationTarget, { sessionId: string; upTo: number; at: number } | null>();
  private readonly batchSize: number;
  private readonly resendAfterMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pumping = false;
  private pumpAgain = false;

  constructor(
    private readonly store: OutboxStore,
    private readonly targets: ReplicationTarget[],
    opts: ReplicatorOptions = {},
  ) {
    this.batchSize = opts.batchSize ?? 500;
    this.resendAfterMs = opts.resendAfterMs ?? 3000;
    for (const t of targets) {
      this.acked.set(t, new Map());
      this.inFlight.set(t, null);
      t.onAck((sessionId, seq) => void this.handleAck(t, sessionId, seq));
      t.onReady(() => {
        this.inFlight.set(t, null);
        this.kick();
      });
    }
  }

  /** Record events locally, then start replicating them. */
  async append(envelopes: EventEnvelope[]): Promise<void> {
    await this.store.put(envelopes);
    this.kick();
  }

  start(intervalMs = 250): void {
    this.timer ??= setInterval(() => this.kick(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  ackedSeq(target: ReplicationTarget, sessionId: string): number {
    return this.acked.get(target)?.get(sessionId) ?? -1;
  }

  /** True when every target has acknowledged everything in the outbox. */
  async drained(): Promise<boolean> {
    return (await this.store.sessions()).length === 0;
  }

  kick(): void {
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    void this.pump().finally(() => {
      this.pumping = false;
      if (this.pumpAgain) {
        this.pumpAgain = false;
        this.kick();
      }
    });
  }

  private async pump(): Promise<void> {
    const now = Date.now();
    for (const t of this.targets) {
      if (!t.ready) continue;
      const flight = this.inFlight.get(t);
      if (flight && now - flight.at < this.resendAfterMs) continue;
      for (const sessionId of await this.store.sessions()) {
        const from = this.ackedSeq(t, sessionId);
        const batch = await this.store.after(sessionId, from, this.batchSize);
        if (!batch.length) continue;
        this.inFlight.set(t, { sessionId, upTo: batch[batch.length - 1]!.seq, at: now });
        t.send(sessionId, batch);
        break; // one batch in flight per target
      }
    }
  }

  private async handleAck(t: ReplicationTarget, sessionId: string, seq: number): Promise<void> {
    const acks = this.acked.get(t)!;
    if (seq > (acks.get(sessionId) ?? -1)) acks.set(sessionId, seq);
    const flight = this.inFlight.get(t);
    if (flight && flight.sessionId === sessionId && seq >= flight.upTo) this.inFlight.set(t, null);
    // Trim what every target has acknowledged.
    const minAck = Math.min(...this.targets.map((x) => this.ackedSeq(x, sessionId)));
    if (minAck >= 0) await this.store.trim(sessionId, minAck);
    this.kick();
  }
}
