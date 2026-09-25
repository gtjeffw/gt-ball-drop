import { z } from 'zod';

/** Experiment configuration (config.json). docs/INSTRUCTIONS.md explains every setting. */
export const DropModeSchema = z.enum(['random', 'lane', 'neighborhood']);
export type DropMode = z.infer<typeof DropModeSchema>;

/**
 * The scene's look (see docs/FIDELITY.md for its origins):
 *  - 'classic': cloudy sky, yellow pit flames (the default)
 *  - 'clean': pale-yellow background, red pit flames
 */
export const WorldSchema = z.enum(['clean', 'classic']);
export type World = z.infer<typeof WorldSchema>;

/** Visual settings. Logged with every session, since they change what participants see. */
export const AppearanceConfigSchema = z.object({
  /** Visual only: the geometry and the logic are the same in both. */
  world: WorldSchema,
  /** Fire-pit flame height (1 = full height, which reaches about 2 units above the paddle). */
  flameHeightScale: z.number().positive().max(2),
  /** Fire-pit flame brightness (the flames are additive). */
  flameOpacity: z.number().min(0).max(1),
  /**
   * How much the light shades the ball and paddle. 0 = flat, high-contrast colours with only
   * a specular highlight. 1 = fully shaded. In between blends the two, keeping the hue.
   */
  modelShading: z.number().min(0).max(1),
});
export type AppearanceConfig = z.infer<typeof AppearanceConfigSchema>;

export const CalibrationConfigSchema = z.object({
  /** Run calibration before the experiment blocks. */
  enabled: z.boolean(),
  /** Direction changes allowed before calibration ends anyway. */
  maxRefinements: z.number().int().min(0),
  /** First speed step (units/ms). Halved at every direction change. */
  speedIncr: z.number().nonnegative(),
  /** Slowest allowed speed (units/ms). */
  speedMin: z.number().positive(),
  /** First drop-interval step (ms). Halved at every direction change. */
  spawnTimeIncrMs: z.number().int().nonnegative(),
  /** Shortest allowed drop interval (ms). */
  spawnTimeMinMs: z.number().int().positive(),
  /** Target catch rate. */
  targetAvg: z.number().min(0).max(1),
  /** Tolerance around the target. */
  targetAvgErr: z.number().min(0).max(1),
  /** Balls per calibration block. */
  numTrials: z.number().int().positive(),
  /** Start with one unscored practice block. */
  startWithPractice: z.boolean(),
  /** Calibration breaks continue by themselves after this long; 0 = wait for a continue. */
  autoContinueMs: z.number().int().nonnegative(),
});

/** Control by the admin panel or another program (the control API) instead of the participant. */
export const RemoteControlConfigSchema = z.object({
  /** Break screens wait for a remote "block-start" instead of the participant. */
  enabled: z.boolean(),
  /** Experiment blocks end only on a remote "block-end" (numTrials is ignored). */
  infiniteTrials: z.boolean(),
  /** The experiment ends only on a remote "quit" (numBlocks is ignored). */
  infiniteBlocks: z.boolean(),
});

export const ExperimentConfigSchema = z.object({
  /** Pre-filled on the start screen. */
  defaultParticipantId: z.string(),
  /** Experiment blocks. */
  numBlocks: z.number().int().positive(),
  /** Balls per experiment block; a block ends when this many are caught or missed. */
  numTrials: z.number().int().positive(),
  /** Stop dropping once numTrials balls have been dropped in the block. */
  onlyCreateNumTrialsBalls: z.boolean(),
  /** Time between drops (ms). */
  ballSpawnTimeMs: z.number().int().positive(),
  /** Fall speed (units/ms). */
  ballSpeed: z.number().positive(),
  dropMode: DropModeSchema,
  /** Furthest jump in neighborhood mode. */
  laneNeighborhoodSize: z.number().int().min(1),
  /** Percent chance [0,100] that the next ball drops in the same lane. */
  laneChangeStayChance: z.number().min(0).max(100),
  appearance: AppearanceConfigSchema,
  calibration: CalibrationConfigSchema,
  remoteControl: RemoteControlConfigSchema,
  /** Seed for the drop-lane RNG. Omit to pick one per session (it is always logged). */
  seed: z.number().int().optional(),
});

export type CalibrationConfig = z.infer<typeof CalibrationConfigSchema>;
export type RemoteControlConfig = z.infer<typeof RemoteControlConfigSchema>;
export type ExperimentConfig = z.infer<typeof ExperimentConfigSchema>;

export const DEFAULT_CONFIG: ExperimentConfig = {
  defaultParticipantId: 'GEORGEPBURDELL000',
  // Lab decision (Sep 2026): 3 blocks of 200 fast balls, no calibration, always change lanes.
  numBlocks: 3,
  numTrials: 200,
  onlyCreateNumTrialsBalls: true,
  ballSpawnTimeMs: 400,
  ballSpeed: 0.01,
  dropMode: 'lane',
  laneNeighborhoodSize: 2,
  laneChangeStayChance: 0,
  appearance: {
    // Lab decision (Sep 2026): the pre-Oct-2012 look (Bright skybox, yellow flames).
    world: 'classic',
    // Lab decision (Sep 2026): lower and dimmer than C4, so the flames don't cover the paddle.
    flameHeightScale: 0.5,
    flameOpacity: 0.7,
    // Lab decision (Sep 2026): full diffuse shading on the ball and paddle, which the C4 materials lacked.
    modelShading: 1,
  },
  calibration: {
    enabled: false,
    maxRefinements: 5,
    speedIncr: 0.003,
    speedMin: 0.001,
    spawnTimeIncrMs: 200,
    spawnTimeMinMs: 100,
    // Lab decision (Sep 2026): the typical dual-task target, 85% ± 5%.
    targetAvg: 0.85,
    targetAvgErr: 0.05,
    numTrials: 100,
    startWithPractice: true,
    autoContinueMs: 2000,
  },
  remoteControl: {
    enabled: false,
    infiniteTrials: false,
    infiniteBlocks: false,
  },
};

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** Merge a partial config over the defaults and validate. Throws a ZodError on bad input. */
export function resolveConfig(partial: DeepPartial<ExperimentConfig> = {}): ExperimentConfig {
  const merged = {
    ...DEFAULT_CONFIG,
    ...partial,
    appearance: { ...DEFAULT_CONFIG.appearance, ...partial.appearance },
    calibration: { ...DEFAULT_CONFIG.calibration, ...partial.calibration },
    remoteControl: { ...DEFAULT_CONFIG.remoteControl, ...partial.remoteControl },
  };
  return ExperimentConfigSchema.parse(merged);
}
