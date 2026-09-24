import { z } from 'zod';

/**
 * Experiment configuration. Defaults match the C4 original's `Game::Game()` constructor
 * (GTBallDrop/Game.cpp); each field notes the legacy `variables.cfg` name it replaces.
 */
export const DropModeSchema = z.enum(['random', 'lane', 'neighborhood']);
export type DropMode = z.infer<typeof DropModeSchema>;

export const CalibrationConfigSchema = z.object({
  /** GTBallCalMode */
  enabled: z.boolean(),
  /** GTBallCalMaxRefinements: direction flips allowed before calibration is forced to end. */
  maxRefinements: z.number().int().min(0),
  /** GTBallCalSpeedIncr (units/ms) */
  speedIncr: z.number().nonnegative(),
  /** GTBallCalSpeedMin (units/ms) */
  speedMin: z.number().positive(),
  /** GTBallCalSpawnTimeIncr (ms) */
  spawnTimeIncrMs: z.number().int().nonnegative(),
  /** GTBallCalSpawnTimeMin (ms) */
  spawnTimeMinMs: z.number().int().positive(),
  /** GTBallCalSpeedTargetAvg: target catch rate. */
  targetAvg: z.number().min(0).max(1),
  /** GTBallCalSpeedTargetAvgErr: tolerance around the target. */
  targetAvgErr: z.number().min(0).max(1),
  /** GTBallCalNumTrials: balls per calibration block. */
  numTrials: z.number().int().positive(),
  /** GTBallCallStartWithPractice (sic): run an unscored practice block first. */
  startWithPractice: z.boolean(),
  /**
   * Auto-continue delay for intermediate calibration breaks. The original hard-coded this
   * on with a 2 s delay (`_autoRestartCalibModeOriginalSetting = true`). 0 = wait for continue.
   */
  autoContinueMs: z.number().int().nonnegative(),
});

export const AdminControlConfigSchema = z.object({
  /** GTBallNetworkSlaveMode: breaks wait for the admin instead of the participant. */
  enabled: z.boolean(),
  /** GTBallNetworkForceInfiniteTrial: experiment blocks end only when the admin ends them. */
  infiniteTrials: z.boolean(),
  /** GTBallNetworkForceInfiniteBlock: the experiment ends only when the admin quits it. */
  infiniteBlocks: z.boolean(),
});

export const ExperimentConfigSchema = z.object({
  /** GTBallParticipantID: pre-filled on the start screen. */
  defaultParticipantId: z.string(),
  /** GTBallNumBlocks */
  numBlocks: z.number().int().positive(),
  /** GTBallNumTrials: balls per experiment block. */
  numTrials: z.number().int().positive(),
  /** GTBallOnlyCreateNumTrialsBalls: stop spawning once numTrials balls exist in the block. */
  onlyCreateNumTrialsBalls: z.boolean(),
  /** GTBallSpawnTimeMS */
  ballSpawnTimeMs: z.number().int().positive(),
  /** GTBallSpeed (units/ms) */
  ballSpeed: z.number().positive(),
  /** GTBallDropMode: 0 random, 1 lane, 2 neighborhood */
  dropMode: DropModeSchema,
  /** GTBallDropLaneNeighborhoodSize */
  laneNeighborhoodSize: z.number().int().min(1),
  /** GTBallLaneChangeStayChance: percent chance [0,100] the drop lane stays put. */
  laneChangeStayChance: z.number().min(0).max(100),
  calibration: CalibrationConfigSchema,
  adminControl: AdminControlConfigSchema,
  /** Seed for the drop-lane RNG. Omit to pick one per session (it is always logged). */
  seed: z.number().int().optional(),
});

export type CalibrationConfig = z.infer<typeof CalibrationConfigSchema>;
export type AdminControlConfig = z.infer<typeof AdminControlConfigSchema>;
export type ExperimentConfig = z.infer<typeof ExperimentConfigSchema>;

export const DEFAULT_CONFIG: ExperimentConfig = {
  defaultParticipantId: 'GEORGEPBURDELL000',
  numBlocks: 3,
  numTrials: 5,
  onlyCreateNumTrialsBalls: true,
  ballSpawnTimeMs: 750,
  ballSpeed: 0.001,
  dropMode: 'lane',
  laneNeighborhoodSize: 2,
  laneChangeStayChance: 50,
  calibration: {
    enabled: true,
    maxRefinements: 5,
    speedIncr: 0.003,
    speedMin: 0.001,
    spawnTimeIncrMs: 200,
    spawnTimeMinMs: 100,
    targetAvg: 0.8,
    targetAvgErr: 0.05,
    numTrials: 5,
    startWithPractice: true,
    autoContinueMs: 2000,
  },
  adminControl: {
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
    calibration: { ...DEFAULT_CONFIG.calibration, ...partial.calibration },
    adminControl: { ...DEFAULT_CONFIG.adminControl, ...partial.adminControl },
  };
  return ExperimentConfigSchema.parse(merged);
}
