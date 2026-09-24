import type { DifficultyParams, ScreenId } from './events';

export type ExperimentPhase = 'not-started' | 'running' | 'paused' | 'ended';

/** Enough for an admin to follow along. Sent over the network, so it stays small. */
export interface ExperimentStatus {
  sessionId: string | null;
  participantId: string | null;
  phase: ExperimentPhase;
  screen: { id: ScreenId; interactive: boolean } | null;
  /** Admin commands are only honoured when the config enables admin control. */
  adminControlled: boolean;
  calibrating: boolean;
  /** -1 = practice block. Only meaningful while calibrating. */
  calibBlock: number;
  block: number;
  numBlocks: number;
  numTrials: number;
  counts: { created: number; destroyed: number; caught: number; missed: number; alive: number };
  difficulty: DifficultyParams;
  catcherLane: number;
  tExp: number;
  tSys: number;
}

export interface BallView {
  id: number;
  x: number;
  z: number;
  /** Spin about the vertical axis in radians (the original spins balls 1°/ms). */
  rot: number;
  /** tSys when the ball was marked missed (it catches fire), else null. */
  burnedAt: number | null;
}

/** Everything a renderer needs for one frame. */
export interface ExperimentSnapshot extends ExperimentStatus {
  catcherX: number;
  balls: BallView[];
}
