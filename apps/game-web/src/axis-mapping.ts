import { GEOMETRY, laneX } from '@gtbd/core';
import type { ControllerConfig } from '@gtbd/protocol';

/** A raw axis reading as −1 (left) to 1 (right): `min` maps to −1 and `max` to 1, clamped. */
export function normalize(raw: number, min: number, max: number, invert: boolean): number {
  const v = max === min ? 0 : Math.max(-1, Math.min(1, ((raw - min) / (max - min)) * 2 - 1));
  return invert ? -v : v;
}

/** 'position' mappings: stretch the axis so ±`reach` of full travel already counts as full. */
export function stretch(v: number, reach: number): number {
  return Math.max(-1, Math.min(1, v / reach));
}

/** Continuous 'position' mapping: −reach..reach spans the outer lanes' centres (world x). */
export function continuousX(v: number, reach: number): number {
  return laneX(0) + ((stretch(v, reach) + 1) / 2) * (laneX(GEOMETRY.laneCount - 1) - laneX(0));
}

/**
 * 'step' mapping: an axis as a pair of keys. Pushing past the threshold is one press; the
 * axis has to come back inside the release band before the next. Holding doesn't repeat.
 */
export class StepMapper {
  private held: 'left' | 'right' | null = null;

  constructor(private readonly cfg: Pick<ControllerConfig, 'stepThreshold' | 'stepRelease'>) {}

  /** The moves this reading causes: none, or one (a jump across the centre can release and press in one reading). */
  update(v: number): ('left' | 'right')[] {
    if (this.held === 'right' && v < this.cfg.stepRelease) this.held = null;
    if (this.held === 'left' && v > -this.cfg.stepRelease) this.held = null;
    if (this.held === null && v >= this.cfg.stepThreshold) this.held = 'right';
    else if (this.held === null && v <= -this.cfg.stepThreshold) this.held = 'left';
    else return [];
    return [this.held];
  }

  /** For display: which side is held down, if any. */
  get state(): 'left' | 'right' | null {
    return this.held;
  }
}

/**
 * 'position' mapping in lanes: the axis range (after `reach`) split into one equal zone per
 * lane. The lane only changes once the axis is `hysteresis` of a zone's width past the edge
 * of the current one.
 */
export class PositionMapper {
  private current: number | null = null;

  constructor(
    private readonly laneCount: number,
    private readonly hysteresis: number,
    private readonly reach = 1,
  ) {}

  update(raw: number): number {
    const v = stretch(raw, this.reach);
    const w = 2 / this.laneCount;
    const zone = Math.max(0, Math.min(this.laneCount - 1, Math.floor((v + 1) / w)));
    if (this.current === null) this.current = zone;
    else if (zone !== this.current) {
      const lo = -1 + this.current * w - this.hysteresis * w;
      const hi = -1 + (this.current + 1) * w + this.hysteresis * w;
      if (v < lo || v > hi) this.current = zone;
    }
    return this.current;
  }

  get lane(): number | null {
    return this.current;
  }
}
