import fs from 'node:fs';
import path from 'node:path';
import type { EventEnvelope, ExperimentConfig } from '@gtbd/protocol';
import { legacyHeader, legacyLines } from '@gtbd/core';

export interface SessionMeta {
  sessionId: string;
  participantId: string;
  startedAt: string;
  appVersion: string;
  /** Machine role that wrote this copy: the participant's primary, or an admin mirror. */
  copy: 'primary' | 'mirror';
  /** Seq ranges missing from this copy (should stay empty; recorded rather than hidden). */
  gaps: { from: number; to: number }[];
}

/**
 * A session's directory on disk:
 *
 *   <root>/<YYYY-MM-DD_HH-MM-SS>_<participantId>/
 *     session.json     metadata
 *     config.json      the exact config in force (the original backed up variables.txt)
 *     events.jsonl     structured events, one EventEnvelope per line: the source of truth
 *     event_log.txt    the legacy C4-format log, derived from the same events
 *
 * append() is idempotent: events with seq <= lastSeq are skipped. Every batch is fsynced
 * before it is acknowledged.
 */
export class SessionFiles {
  private lastSeqValue: number;
  private readonly jsonlFd: number;
  private readonly legacyFd: number;
  /** Everything stored, in seq order. Sessions are a few MB at most, and mirrors catch up from here. */
  private readonly envelopes: EventEnvelope[];

  private constructor(
    readonly dir: string,
    readonly meta: SessionMeta,
    envelopes: EventEnvelope[],
  ) {
    this.envelopes = envelopes;
    this.lastSeqValue = envelopes.length ? envelopes[envelopes.length - 1]!.seq : -1;
    this.jsonlFd = fs.openSync(path.join(dir, 'events.jsonl'), 'a');
    this.legacyFd = fs.openSync(path.join(dir, 'event_log.txt'), 'a');
  }

  get lastSeq(): number {
    return this.lastSeqValue;
  }

  static create(root: string, meta: Omit<SessionMeta, 'gaps'>, config: ExperimentConfig | null): SessionFiles {
    const started = new Date(meta.startedAt);
    const p = (n: number) => String(n).padStart(2, '0');
    const stamp = `${started.getFullYear()}-${p(started.getMonth() + 1)}-${p(started.getDate())}_${p(started.getHours())}-${p(started.getMinutes())}-${p(started.getSeconds())}`;
    const safePid = meta.participantId.replace(/[^\w.-]+/g, '_').slice(0, 64) || 'unknown';
    let dir = path.join(root, `${stamp}_${safePid}`);
    for (let n = 2; fs.existsSync(dir); n++) dir = path.join(root, `${stamp}_${safePid}_${n}`);
    fs.mkdirSync(dir, { recursive: true });
    const full: SessionMeta = { ...meta, gaps: [] };
    writeJson(path.join(dir, 'session.json'), full);
    if (config) writeJson(path.join(dir, 'config.json'), config);
    fs.writeFileSync(path.join(dir, 'event_log.txt'), legacyHeader(started));
    return new SessionFiles(dir, full, []);
  }

  /** Reopen an existing session directory (after a restart), resuming from its last seq. */
  static open(dir: string): SessionFiles {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')) as SessionMeta;
    const envelopes: EventEnvelope[] = [];
    const jsonl = path.join(dir, 'events.jsonl');
    if (fs.existsSync(jsonl)) {
      for (const line of fs.readFileSync(jsonl, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          envelopes.push(JSON.parse(line) as EventEnvelope);
        } catch {
          // A torn last line from a crash. Later lines are still appended after it.
        }
      }
    }
    envelopes.sort((a, b) => a.seq - b.seq);
    return new SessionFiles(dir, meta, envelopes);
  }

  /** Append new events and return the highest seq now stored. */
  append(envelopes: EventEnvelope[]): number {
    let jsonl = '';
    let legacy = '';
    for (const env of [...envelopes].sort((a, b) => a.seq - b.seq)) {
      if (env.sessionId !== this.meta.sessionId || env.seq <= this.lastSeqValue) continue;
      if (env.seq > this.lastSeqValue + 1) {
        this.meta.gaps.push({ from: this.lastSeqValue + 1, to: env.seq - 1 });
        writeJson(path.join(this.dir, 'session.json'), this.meta);
      }
      jsonl += JSON.stringify(env) + '\n';
      legacy += legacyLines(env.event);
      this.envelopes.push(env);
      this.lastSeqValue = env.seq;
    }
    if (jsonl) {
      fs.writeSync(this.jsonlFd, jsonl);
      fs.fdatasyncSync(this.jsonlFd);
    }
    if (legacy) {
      fs.writeSync(this.legacyFd, legacy);
      fs.fdatasyncSync(this.legacyFd);
    }
    return this.lastSeqValue;
  }

  /** Stored events with seq > afterSeq (used to catch up a mirror). */
  readAfter(afterSeq: number, limit = 1000): EventEnvelope[] {
    let lo = 0;
    let hi = this.envelopes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.envelopes[mid]!.seq <= afterSeq) lo = mid + 1;
      else hi = mid;
    }
    return this.envelopes.slice(lo, lo + limit);
  }

  close(): void {
    fs.closeSync(this.jsonlFd);
    fs.closeSync(this.legacyFd);
  }
}

function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
