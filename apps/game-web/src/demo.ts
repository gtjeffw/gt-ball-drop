import { resolveConfig, type ExperimentConfig } from '@gtbd/protocol';
import study2017 from '../../../docs/examples/config.2017-study.json';

/** Settings a demo visitor can pick from (?preset=...). */
export const DEMO_PRESETS: { id: string; label: string; config: ExperimentConfig }[] = [
  {
    id: 'quick',
    label: 'Quick look: 2 short blocks, no calibration',
    config: resolveConfig({
      defaultParticipantId: 'DEMO',
      calibration: { enabled: false },
      numBlocks: 2,
      numTrials: 15,
      ballSpeed: 0.004,
      ballSpawnTimeMs: 900,
    }),
  },
  {
    id: 'calibration',
    label: 'Full session with difficulty calibration (default settings)',
    config: resolveConfig({ defaultParticipantId: 'DEMO' }),
  },
  {
    id: 'study2017',
    label: '2017 study settings: fast, 3 blocks of 300 balls',
    config: resolveConfig({ ...(study2017 as unknown as Partial<ExperimentConfig>), defaultParticipantId: 'DEMO' }),
  },
];

export function demoPreset(params: URLSearchParams): { id: string; config: ExperimentConfig } {
  const p = DEMO_PRESETS.find((x) => x.id === params.get('preset')) ?? DEMO_PRESETS[0]!;
  return { id: p.id, config: p.config };
}

