import type { DropMode } from '@gtbd/protocol';
import type { Rng } from './rng';

export interface LaneChoiceParams {
  mode: DropMode;
  laneCount: number;
  /** Percent chance [0,100] of staying put (lane and neighborhood modes). */
  stayChance: number;
  /** Max lanes jumped in neighborhood mode. */
  neighborhoodSize: number;
}

/**
 * Choose the next drop lane (from BallMagister::Update). Lanes are indexed 0..laneCount-1
 * from left to right on screen.
 */
export function nextDropLane(current: number, p: LaneChoiceParams, rng: Rng): number {
  switch (p.mode) {
    case 'lane': {
      if (rng.float(100) < p.stayChance) return current;
      const hasLeft = current > 0;
      const hasRight = current < p.laneCount - 1;
      if (!hasLeft && !hasRight) return current;
      if (!hasLeft) return current + 1;
      if (!hasRight) return current - 1;
      // The original's comment says 0 means left, but the code picks right. It's 50/50 either way.
      return rng.int(2) === 0 ? current + 1 : current - 1;
    }
    case 'neighborhood': {
      const numLeft = Math.min(current, p.neighborhoodSize);
      const numRight = Math.min(p.laneCount - current - 1, p.neighborhoodSize);
      if (rng.float(100) < p.stayChance) return current;
      // The original calls Math::Random(0) here if there are no neighbours; stay put instead.
      if (numLeft + numRight === 0) return current;
      const choice = rng.int(numLeft + numRight);
      return choice < numLeft ? current - choice - 1 : current + (choice - numLeft) + 1;
    }
    case 'random':
      return rng.int(p.laneCount);
  }
}
