import type { CalibrationConfig } from '@gtbd/protocol';

/** Staircase state carried between calibration blocks (BallMagister's `_adjustDir` etc.). */
export interface StaircaseState {
  /** +1 = making it harder, -1 = making it easier. */
  adjustDir: number;
  spawnTimeIncrMs: number;
  speedIncr: number;
  flipCount: number;
  ballSpeed: number;
  spawnTimeMs: number;
}

export interface StaircaseResult {
  catchRate: number;
  done: boolean;
  reason: 'target-hit' | 'max-refinements' | null;
  /** State for the next block. When done, ballSpeed/spawnTimeMs are the final difficulty. */
  next: StaircaseState;
}

export function initialStaircase(cal: CalibrationConfig, ballSpeed: number, spawnTimeMs: number): StaircaseState {
  return { adjustDir: 1, spawnTimeIncrMs: cal.spawnTimeIncrMs, speedIncr: cal.speedIncr, flipCount: 0, ballSpeed, spawnTimeMs };
}

/**
 * One step of the calibration staircase, run when a calibration block ends
 * (port of BallMagister::updateCalibrateMode). `calibBlock` -1 is the practice block: it
 * is not scored and changes nothing.
 */
export function stepStaircase(
  s: StaircaseState,
  calibBlock: number,
  caught: number,
  missed: number,
  cal: CalibrationConfig,
): StaircaseResult {
  const next = { ...s };
  // NaN when nothing was resolved. As in the original, NaN fails both comparisons below,
  // which counts as hitting the target.
  const catchRate = caught / (caught + missed);
  let done = false;
  let reason: StaircaseResult['reason'] = null;

  if (calibBlock >= 0) {
    if (catchRate > cal.targetAvg + cal.targetAvgErr) {
      // Too easy: make it harder.
      if (next.adjustDir <= 0) {
        next.flipCount++;
        if (next.flipCount > cal.maxRefinements) {
          done = true;
          reason = 'max-refinements';
        } else {
          next.adjustDir = 1;
          next.spawnTimeIncrMs = Math.floor(next.spawnTimeIncrMs / 2); // unsigned long division
          next.speedIncr /= 2;
        }
      }
    } else if (catchRate < cal.targetAvg - cal.targetAvgErr) {
      // Too hard: make it easier.
      if (next.adjustDir > 0) {
        next.flipCount++;
        if (next.flipCount > cal.maxRefinements) {
          done = true;
          reason = 'max-refinements';
        } else {
          next.adjustDir = -1;
          next.spawnTimeIncrMs = Math.floor(next.spawnTimeIncrMs / 2);
          next.speedIncr /= 2;
        }
      }
    } else {
      done = true;
      reason = 'target-hit';
    }
  }

  if (!done && calibBlock >= 0) {
    // The original does this in unsigned arithmetic, so the spawn time wraps to about 4e9 ms
    // (and balls stop dropping) instead of clamping. Clamp properly. See docs/FIDELITY.md.
    next.spawnTimeMs = Math.max(cal.spawnTimeMinMs, next.spawnTimeMs - next.spawnTimeIncrMs * next.adjustDir);
    next.ballSpeed = Math.max(cal.speedMin, next.ballSpeed + next.speedIncr * next.adjustDir);
  }

  return { catchRate, done, reason, next };
}
