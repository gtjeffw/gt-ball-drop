import type { DomainEvent, EventEnvelope } from '@gtbd/protocol';

/**
 * Assigns the gap-free sequence numbers that make every sink idempotent. There is exactly
 * one recorder per session, running wherever the experiment core runs.
 */
export class SessionRecorder {
  private seq: number;

  constructor(
    readonly sessionId: string,
    private readonly now: () => number = Date.now,
    startSeq = 0,
  ) {
    this.seq = startSeq;
  }

  get lastSeq(): number {
    return this.seq - 1;
  }

  record(event: DomainEvent): EventEnvelope {
    return { schema: 1, sessionId: this.sessionId, seq: this.seq++, tWall: this.now(), event };
  }
}
