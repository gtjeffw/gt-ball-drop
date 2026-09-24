import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { Experiment, SessionRecorder } from '@gtbd/core';
import { GTBALLDROP_VERSION, resolveConfig, type EventEnvelope } from '@gtbd/protocol';
import { IndexedDbOutboxStore } from '@gtbd/sinks';
import { browserCapture } from '../src/capture';
import { crc32, zip } from '../src/zip';

/** Read a stored (uncompressed) ZIP back into name -> text, checking each CRC. */
function unzip(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();
  const out = new Map<string, string>();
  let o = 0;
  while (view.getUint32(o, true) === 0x04034b50) {
    expect(view.getUint16(o + 8, true)).toBe(0); // stored
    const crc = view.getUint32(o + 14, true);
    const size = view.getUint32(o + 18, true);
    const nameLen = view.getUint16(o + 26, true);
    const name = dec.decode(bytes.subarray(o + 30, o + 30 + nameLen));
    const data = bytes.subarray(o + 30 + nameLen, o + 30 + nameLen + size);
    expect(crc32(data)).toBe(crc);
    out.set(name, dec.decode(data));
    o += 30 + nameLen + size;
  }
  expect(view.getUint32(o, true)).toBe(0x02014b50); // then the central directory
  const end = bytes.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  expect(view.getUint16(end + 10, true)).toBe(out.size);
  expect(view.getUint32(end + 16, true)).toBe(o); // central directory offset
  return out;
}

describe('zip', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('writes files that read back unchanged', () => {
    const files = unzip(zip([{ name: 'a/b.txt', data: 'héllo\r\n' }, { name: 'c.bin', data: new Uint8Array([0, 1, 2]) }]));
    expect([...files.keys()]).toEqual(['a/b.txt', 'c.bin']);
    expect(files.get('a/b.txt')).toBe('héllo\r\n');
  });
});

function runSession(capture: ReturnType<typeof browserCapture>, sessionId: string, participantId: string) {
  const config = resolveConfig({ calibration: { enabled: false }, numBlocks: 1, numTrials: 3, ballSpeed: 0.01 });
  const startedAt = new Date(2026, 8, 24, 10, 0, 0);
  capture.openSession({ sessionId, participantId, version: GTBALLDROP_VERSION, startedAt: startedAt.toISOString(), config });
  const exp = new Experiment({ config, participantId, seed: 1, version: GTBALLDROP_VERSION, sessionId });
  const rec = new SessionRecorder(sessionId, () => startedAt.getTime());
  exp.on((e) => capture.record([rec.record(e)]));
  exp.start();
  for (let t = 0; t < 30_000 && exp.status().phase !== 'ended'; t++) {
    if (exp.status().screen?.interactive) exp.dispatch({ type: 'continue', source: 'participant' });
    exp.advance(1);
  }
  return config;
}

describe('browserCapture', () => {
  it('keeps the session in browser storage and offers it as one zip', async () => {
    const capture = browserCapture(new IndexedDbOutboxStore('test-browser-1'));
    const config = runSession(capture, 's-1', 'P 01');

    const r = await capture.finish();
    expect(r.saved).toBe(true);
    expect(r.downloads).toHaveLength(1);
    const d = r.downloads[0]!;
    expect(d.name).toBe('2026-09-24_10-00-00_P_01.zip');
    const files = unzip(new Uint8Array(await d.blob.arrayBuffer()));
    const stem = '2026-09-24_10-00-00_P_01';
    expect([...files.keys()]).toEqual([`${stem}/events.jsonl`, `${stem}/event_log.txt`, `${stem}/config.json`]);

    const lines = files.get(`${stem}/events.jsonl`)!.trim().split('\n').map((l) => JSON.parse(l) as EventEnvelope);
    expect(lines.map((e) => e.seq)).toEqual(lines.map((_, i) => i));
    const log = files.get(`${stem}/event_log.txt`)!;
    expect(log.startsWith('0.000,DATE,09/24/2026\r\n0.000,TIME,10:00:00\r\n')).toBe(true);
    expect(log).toMatch(/BLOCK_RESULTS,0,\d+,\d+,3\r\n/);
    expect(log.trimEnd().endsWith('EXPERIMENT_END')).toBe(true);
    expect(JSON.parse(files.get(`${stem}/config.json`)!)).toEqual(config);
  });

  it('lists stored sessions after a reload, and discards them', async () => {
    const first = browserCapture(new IndexedDbOutboxStore('test-browser-2'));
    runSession(first, 's-a', 'A');
    await first.finish();

    // A new page load: a fresh capture over the same database.
    const again = browserCapture(new IndexedDbOutboxStore('test-browser-2'));
    const stored = await again.stored();
    expect(stored.map((s) => [s.sessionId, s.participantId, s.startedAt.getTime()])).toEqual([['s-a', 'A', new Date(2026, 8, 24, 10).getTime()]]);
    expect(stored[0]!.events).toBeGreaterThan(5);
    expect((await again.exportSession('s-a')).name).toBe('2026-09-24_10-00-00_A.zip');

    await again.discard('s-a');
    expect(await again.stored()).toEqual([]);
  });
});
