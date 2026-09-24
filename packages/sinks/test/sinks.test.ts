import 'fake-indexeddb/auto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type EventEnvelope } from '@gtbd/protocol';
import { IndexedDbOutboxStore, MemoryOutboxStore, Replicator, type ReplicationTarget } from '../src';
import { SessionFiles } from '../src/node';

const env = (seq: number, sessionId = 's1'): EventEnvelope => ({
  schema: 1,
  sessionId,
  seq,
  tWall: 1_700_000_000_000 + seq,
  event: { type: 'ball-caught', ballId: seq, lane: 3, catcherX: 0, count: seq + 1, tExp: seq * 100, tSys: seq * 100 },
});

/** A target that stores events like a real sink: idempotent, acks its highest stored seq. */
class FakeTarget implements ReplicationTarget {
  ready = true;
  stored: EventEnvelope[] = [];
  sends = 0;
  private ack: (s: string, n: number) => void = () => {};
  private readyCb: () => void = () => {};
  constructor(readonly name: string, private readonly autoAck = true) {}
  send(sessionId: string, events: EventEnvelope[]) {
    this.sends++;
    for (const e of events) if (!this.stored.some((x) => x.sessionId === e.sessionId && x.seq === e.seq)) this.stored.push(e);
    if (this.autoAck) queueMicrotask(() => this.ack(sessionId, Math.max(...this.stored.filter((e) => e.sessionId === sessionId).map((e) => e.seq))));
  }
  onAck(cb: (s: string, n: number) => void) {
    this.ack = cb;
  }
  onReady(cb: () => void) {
    this.readyCb = cb;
  }
  reconnect() {
    this.ready = true;
    this.readyCb();
  }
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe('Replicator', () => {
  it('delivers everything to every target and trims only what all have acked', async () => {
    const store = new MemoryOutboxStore();
    const a = new FakeTarget('host');
    const b = new FakeTarget('cloud', false); // never acks
    const rep = new Replicator(store, [a, b]);
    await rep.append([env(0), env(1), env(2)]);
    await settle();
    expect(a.stored.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(b.stored.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(await store.after('s1', -1, 100)).toHaveLength(3); // b hasn't acked, so nothing is trimmed
  });

  it('resumes after a target reconnects, without gaps or duplicates', async () => {
    const store = new MemoryOutboxStore();
    const t = new FakeTarget('host');
    const rep = new Replicator(store, [t]);
    await rep.append([env(0), env(1)]);
    await settle();
    t.ready = false;
    await rep.append([env(2), env(3)]);
    await settle();
    expect(t.stored.map((e) => e.seq)).toEqual([0, 1]);
    t.reconnect();
    await settle();
    expect(t.stored.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect(await rep.drained()).toBe(true);
  });
});

describe('IndexedDbOutboxStore', () => {
  it('stores, pages in seq order, trims, and lists sessions', async () => {
    const store = new IndexedDbOutboxStore(`test-${Math.random()}`);
    await store.put([env(2), env(0), env(1), env(0, 's2')]);
    expect((await store.after('s1', -1, 10)).map((e) => e.seq)).toEqual([0, 1, 2]);
    expect((await store.after('s1', 0, 1)).map((e) => e.seq)).toEqual([1]);
    expect((await store.sessions()).sort()).toEqual(['s1', 's2']);
    await store.trim('s1', 1);
    expect((await store.after('s1', -1, 10)).map((e) => e.seq)).toEqual([2]);
  });
});

describe('SessionFiles', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gtbd-'));
  const meta = { sessionId: 's1', participantId: 'P 001/x', startedAt: new Date(2026, 8, 24, 9, 5, 7).toISOString(), appVersion: 'test', copy: 'primary' as const };

  it('writes jsonl + legacy log idempotently and fsyncs', () => {
    const root = tmp();
    const sf = SessionFiles.create(root, meta, DEFAULT_CONFIG);
    expect(path.basename(sf.dir)).toBe('2026-09-24_09-05-07_P_001_x');
    expect(sf.append([env(0), env(1)])).toBe(1);
    expect(sf.append([env(1), env(2)])).toBe(2); // 1 is a duplicate
    sf.close();
    const lines = fs.readFileSync(path.join(sf.dir, 'events.jsonl'), 'utf8').trim().split('\n');
    expect(lines.map((l) => JSON.parse(l).seq)).toEqual([0, 1, 2]);
    const legacy = fs.readFileSync(path.join(sf.dir, 'event_log.txt'), 'utf8');
    expect(legacy).toBe(
      '0.000,DATE,09/24/2026\r\n0.000,TIME,09:05:07\r\n0.000,BALL_CAUGHT,1\r\n0.100,BALL_CAUGHT,2\r\n0.200,BALL_CAUGHT,3\r\n',
    );
    expect(JSON.parse(fs.readFileSync(path.join(sf.dir, 'config.json'), 'utf8'))).toEqual(DEFAULT_CONFIG);
  });

  it('reopens after a restart, resumes from the last seq, and records gaps', () => {
    const root = tmp();
    const a = SessionFiles.create(root, meta, null);
    a.append([env(0), env(1)]);
    a.close();
    const b = SessionFiles.open(a.dir);
    expect(b.lastSeq).toBe(1);
    b.append([env(4)]);
    expect(b.meta.gaps).toEqual([{ from: 2, to: 3 }]);
    expect(b.readAfter(0).map((e) => e.seq)).toEqual([1, 4]);
    b.close();
  });
});
