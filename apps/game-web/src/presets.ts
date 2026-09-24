import { resolveConfig, type DeepPartial, type ExperimentConfig } from '@gtbd/protocol';
import study2017 from '../../../docs/examples/config.2017-study.json';

/**
 * Starting points on the browser-mode setup screen (also ?preset=<id> in the URL). Presets
 * set the session, timing and drop settings only: the look stays at the lab defaults.
 */
export const PRESETS: { id: string; label: string; config: ExperimentConfig }[] = [
  {
    id: 'calibration',
    label: 'Default settings, with difficulty calibration',
    config: resolveConfig({ calibration: { enabled: true } }),
  },
  {
    id: 'quick',
    label: 'Quick look: 2 short blocks, no calibration',
    config: resolveConfig({ calibration: { enabled: false }, numBlocks: 2, numTrials: 15, ballSpeed: 0.004, ballSpawnTimeMs: 900 }),
  },
  {
    id: 'study2017',
    label: '2017 study timing: fast, 3 blocks of 300 balls',
    config: withoutLook(study2017 as DeepPartial<ExperimentConfig>),
  },
];

function withoutLook({ appearance: _, ...rest }: DeepPartial<ExperimentConfig>): ExperimentConfig {
  return resolveConfig(rest);
}

export function preset(id: string | null): ExperimentConfig | null {
  return PRESETS.find((p) => p.id === id)?.config ?? null;
}
