import { describe, expect, it } from 'vitest';
import { Experiment, SessionRecorder } from '@gtbd/core';
import { GTBALLDROP_VERSION, resolveConfig, type EventEnvelope } from '@gtbd/protocol';
import { demoCapture } from '../src/capture';

describe('demoCapture', () => {
  it('keeps the session in memory and offers events.jsonl, event_log.txt and config.json', async () => {
    const config = resolveConfig({ calibration: { enabled: false }, numBlocks: 1, numTrials: 3, ballSpeed: 0.01 });
    const capture = demoCapture();
    const startedAt = new Date(2026, 8, 24, 10, 0, 0).toISOString();
    capture.openSession({ sessionId: 's-demo', participantId: 'DEMO', version: GTBALLDROP_VERSION, startedAt, config });
    const exp = new Experiment({ config, participantId: 'DEMO', seed: 1, version: GTBALLDROP_VERSION });
    const rec = new SessionRecorder('s-demo', () => 0);
    exp.on((e) => capture.record([rec.record(e)]));
    exp.start();
    for (let t = 0; t < 30_000 && exp.status().phase !== 'ended'; t++) {
      if (exp.status().screen?.interactive) exp.dispatch({ type: 'continue', source: 'participant' });
      exp.advance(1);
    }

    const r = await capture.finish();
    expect(r.saved).toBe(true);
    expect(r.downloads.map((d) => d.label)).toEqual(['events.jsonl', 'event_log.txt', 'config.json']);
    const [jsonl, log, cfg] = await Promise.all(r.downloads.map((d) => d.blob.text()));
    const lines = jsonl!.trim().split('\n').map((l) => JSON.parse(l) as EventEnvelope);
    expect(lines.map((e) => e.seq)).toEqual(lines.map((_, i) => i));
    expect(log!.startsWith('0.000,DATE,09/24/2026\r\n0.000,TIME,10:00:00\r\n')).toBe(true);
    expect(log).toMatch(/BLOCK_RESULTS,0,\d+,\d+,3\r\n/);
    expect(log!.trimEnd().endsWith('EXPERIMENT_END')).toBe(true);
    expect(JSON.parse(cfg!)).toEqual(config);
    expect(r.downloads[0]!.name).toMatch(/_DEMO_events\.jsonl$/);
  });
});
