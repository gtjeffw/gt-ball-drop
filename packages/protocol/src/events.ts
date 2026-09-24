import { z } from 'zod';
import type { ExperimentConfig } from './config';

/** Pause screens. Each one corresponds to a dialog in the original (Interface.cpp). */
export type ScreenId =
  | 'calibration-intro'
  | 'calibration-break'
  | 'calibration-complete'
  | 'block-intro'
  | 'block-break'
  | 'complete';

/** Who dismissed a screen. `experimenter` is the hidden 9 key on non-interactive screens. */
export type ContinueSource = 'participant' | 'experimenter' | 'admin' | 'auto';

export interface BlockCounts {
  missed: number;
  caught: number;
  dropped: number;
}

export interface DifficultyParams {
  ballSpeed: number;
  spawnTimeMs: number;
  laneStayChance: number;
}

/**
 * Domain events emitted by the experiment core. Times are milliseconds since the session
 * started:
 *  - `tExp`: experiment time, which stops during pause screens (the C4 world clock; the
 *    legacy log's timestamps use it)
 *  - `tSys`: time that keeps running through pauses
 */
export type DomainEvent = { tExp: number; tSys: number } & (
  | { type: 'session-started'; version: string; participantId: string; seed: number; config: ExperimentConfig }
  | { type: 'calibration-started' }
  | ({ type: 'calibration-block-started'; calibBlock: number } & DifficultyParams)
  | ({ type: 'calibration-block-ended'; calibBlock: number; adjustDir: number; flipCount: number; catchRate: number } & BlockCounts)
  | ({ type: 'calibration-ended'; reason: 'target-hit' | 'max-refinements' } & DifficultyParams)
  | { type: 'block-started'; block: number }
  | ({ type: 'block-ended'; block: number; forcedByAdmin: boolean } & BlockCounts)
  | { type: 'experiment-ended'; forcedByAdmin: boolean }
  | { type: 'experiment-aborted'; reason: string }
  | { type: 'ball-spawned'; ballId: number; lane: number; speed: number }
  | { type: 'ball-caught'; ballId: number; lane: number; catcherX: number; count: number }
  | { type: 'ball-missed'; ballId: number; lane: number; catcherLane: number; count: number }
  | { type: 'ball-removed'; ballId: number }
  /** `legacyColumn` is null when the original would not have logged the move (at the edge). */
  | { type: 'catcher-moved'; direction: 'left' | 'right'; lane: number; legacyColumn: number | null }
  | { type: 'screen-shown'; screen: ScreenId; interactive: boolean }
  | { type: 'screen-dismissed'; screen: ScreenId; by: ContinueSource }
  /** `source` says who sent it, e.g. 'admin-panel@a-1234', 'control-api@a-1234', 'control-api@local'. */
  | { type: 'remote-command'; command: ControlCommand; accepted: boolean; source: string }
  | { type: 'admin-link'; status: 'connected' | 'lost'; peerId: string }
  | { type: 'clock-sync'; peerId: string; offsetMs: number; rttMs: number }
);

export type DomainEventType = DomainEvent['type'];
export type EventOf<T extends DomainEventType> = Extract<DomainEvent, { type: T }>;

/** Commands from the admin panel or the control API. */
export type ControlCommand =
  | 'block-start' // dismiss the current break screen (start calibration, continue, start the next block)
  | 'block-end' // end the current block
  | 'quit'; // end the block and the experiment

/**
 * A persisted event. `(sessionId, seq)` is unique and gap-free, so every sink can apply
 * events idempotently and resume replication from the last acknowledged seq.
 */
export interface EventEnvelope<E extends DomainEvent = DomainEvent> {
  schema: 1;
  sessionId: string;
  seq: number;
  /** Wall-clock epoch ms when the event was recorded (for aligning across machines). */
  tWall: number;
  event: E;
}

export const EventEnvelopeSchema = z.object({
  schema: z.literal(1),
  sessionId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  tWall: z.number(),
  event: z.looseObject({ type: z.string(), tExp: z.number(), tSys: z.number() }),
});
