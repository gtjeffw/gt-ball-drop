import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '@gtbd/protocol';
import { PRESETS } from '../src/presets';

describe('presets', () => {
  it('keep the default look', () => {
    for (const p of PRESETS) expect([p.id, p.config.appearance]).toEqual([p.id, DEFAULT_CONFIG.appearance]);
  });

  it('keep the 2017 study timing', () => {
    const p = PRESETS.find((x) => x.id === 'study2017')!.config;
    expect([p.ballSpeed, p.ballSpawnTimeMs, p.numTrials, p.dropMode]).toEqual([0.01, 400, 300, 'neighborhood']);
  });
});
