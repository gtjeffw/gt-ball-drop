import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '@gtbd/protocol';
import { initialStaircase, nextDropLane, Rng, Spring, stepStaircase } from '../src';

const cal = DEFAULT_CONFIG.calibration;

describe('Spring (port of Spring.cpp)', () => {
  it('uses critical damping b = 2*sqrt(k*m) = 20 for k=200, m=0.5', () => {
    const s = new Spring(0, 0, 200, 0.1, 0.5, 100);
    s.setDampingCritical();
    expect(s.damping).toBeCloseTo(20, 10);
  });

  it('eases a 2-unit lane change as x(t) = 2(1+20t)e^(-20t), with no overshoot', () => {
    const s = new Spring(0, 0, 200, 0.1, 0.5, 100);
    s.setDampingCritical();
    s.setPosition(2);
    let t = 0;
    let minPos = Infinity;
    let at200ms = NaN;
    while (!s.isStopped() && t < 2) {
      s.step(0.001);
      t = Math.round((t + 0.001) * 1000) / 1000;
      if (t === 0.2) at200ms = s.pos;
      minPos = Math.min(minPos, s.pos);
    }
    expect(at200ms).toBeCloseTo(2 * 5 * Math.exp(-4), 4); // about 91% of the way there after 200 ms
    expect(s.isStopped()).toBe(true); // halts at the 0.01 pos/vel threshold, ~0.53 s
    expect(t).toBeLessThan(0.6);
    expect(minPos).toBeGreaterThanOrEqual(0);
  });

  it('clamps an over-range position to +max, as the original does (sign is lost)', () => {
    const s = new Spring(0, 0, 200, 0.1, 0.5, 100);
    s.setPosition(-150);
    expect(s.pos).toBe(100);
  });
});

describe('nextDropLane', () => {
  const rng = () => new Rng(42);
  const base = { laneCount: 7, neighborhoodSize: 2 };

  it('lane mode: stayChance 100 never moves; 0 always moves exactly one lane', () => {
    const r = rng();
    for (let i = 0; i < 200; i++) expect(nextDropLane(3, { ...base, mode: 'lane', stayChance: 100 }, r)).toBe(3);
    let lane = 3;
    for (let i = 0; i < 500; i++) {
      const next = nextDropLane(lane, { ...base, mode: 'lane', stayChance: 0 }, r);
      expect(Math.abs(next - lane)).toBe(1);
      expect(next).toBeGreaterThanOrEqual(0);
      expect(next).toBeLessThan(7);
      lane = next;
    }
  });

  it('lane mode: forced inward at the edges', () => {
    const r = rng();
    expect(nextDropLane(0, { ...base, mode: 'lane', stayChance: 0 }, r)).toBe(1);
    expect(nextDropLane(6, { ...base, mode: 'lane', stayChance: 0 }, r)).toBe(5);
  });

  it('neighborhood mode: reaches every lane within the neighborhood and nothing beyond', () => {
    const r = rng();
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) seen.add(nextDropLane(3, { ...base, mode: 'neighborhood', stayChance: 0 }, r));
    expect([...seen].sort()).toEqual([1, 2, 4, 5]);
    const edge = new Set<number>();
    for (let i = 0; i < 2000; i++) edge.add(nextDropLane(0, { ...base, mode: 'neighborhood', stayChance: 0 }, r));
    expect([...edge].sort()).toEqual([1, 2]);
  });

  it('neighborhood mode with a single lane stays put instead of calling Random(0)', () => {
    expect(nextDropLane(0, { mode: 'neighborhood', laneCount: 1, stayChance: 0, neighborhoodSize: 2 }, rng())).toBe(0);
  });

  it('random mode covers all lanes roughly uniformly', () => {
    const r = rng();
    const counts = new Array(7).fill(0);
    for (let i = 0; i < 7000; i++) counts[nextDropLane(3, { ...base, mode: 'random', stayChance: 50 }, r)]++;
    for (const c of counts) expect(c).toBeGreaterThan(850);
  });

  it('is reproducible from its seed', () => {
    const seq = (seed: number) => {
      const r = new Rng(seed);
      let lane = 3;
      return Array.from({ length: 50 }, () => (lane = nextDropLane(lane, { ...base, mode: 'lane', stayChance: 50 }, r)));
    };
    expect(seq(7)).toEqual(seq(7));
    expect(seq(7)).not.toEqual(seq(8));
  });
});

describe('stepStaircase (port of BallMagister::updateCalibrateMode)', () => {
  const s0 = initialStaircase(cal, 0.001, 750);

  it('practice block (-1) changes nothing', () => {
    const r = stepStaircase(s0, -1, 5, 0, cal);
    expect(r.done).toBe(false);
    expect(r.next).toEqual(s0);
  });

  it('hand-traced sequence: too easy, too easy, too hard (flip), on target', () => {
    // Block 0: 5/5 caught, above 0.85, already going harder: spawn 750-200, speed +0.003.
    const r0 = stepStaircase(s0, 0, 5, 0, cal);
    expect(r0.done).toBe(false);
    expect(r0.next.adjustDir).toBe(1);
    expect(r0.next.spawnTimeMs).toBe(550);
    expect(r0.next.ballSpeed).toBeCloseTo(0.004, 12);

    // Block 1: still too easy, same direction: 550-200, 0.004+0.003.
    const r1 = stepStaircase(r0.next, 1, 5, 0, cal);
    expect(r1.next.spawnTimeMs).toBe(350);
    expect(r1.next.ballSpeed).toBeCloseTo(0.007, 12);

    // Block 2: 1/5 = 0.2, too hard: flip to easier, halve the increments (100, 0.0015).
    const r2 = stepStaircase(r1.next, 2, 1, 4, cal);
    expect(r2.next.flipCount).toBe(1);
    expect(r2.next.adjustDir).toBe(-1);
    expect(r2.next.spawnTimeIncrMs).toBe(100);
    expect(r2.next.speedIncr).toBeCloseTo(0.0015, 12);
    expect(r2.next.spawnTimeMs).toBe(450);
    expect(r2.next.ballSpeed).toBeCloseTo(0.0055, 12);

    // Block 3: exactly 0.8, on target: done, and the difficulty stays where it is.
    const r3 = stepStaircase(r2.next, 3, 4, 1, cal);
    expect(r3.done).toBe(true);
    expect(r3.reason).toBe('target-hit');
    expect(r3.next.spawnTimeMs).toBe(450);
  });

  it('halving the spawn increment uses integer division, like unsigned long', () => {
    const s = { ...s0, spawnTimeIncrMs: 25, adjustDir: -1 };
    expect(stepStaircase(s, 0, 5, 0, cal).next.spawnTimeIncrMs).toBe(12);
  });

  it('clamps spawn time at the minimum instead of wrapping (the original unsigned-underflow bug)', () => {
    const s = { ...s0, spawnTimeMs: 150 };
    const r = stepStaircase(s, 0, 5, 0, cal);
    expect(r.next.spawnTimeMs).toBe(cal.spawnTimeMinMs);
  });

  it('clamps ball speed at the minimum', () => {
    const s = { ...s0, adjustDir: -1, ballSpeed: 0.002 };
    const r = stepStaircase(s, 0, 0, 5, cal);
    expect(r.next.ballSpeed).toBe(cal.speedMin);
  });

  it('ends after more than maxRefinements direction flips', () => {
    const c = { ...cal, maxRefinements: 1 };
    const a = stepStaircase(s0, 0, 0, 5, c); // too hard: flip 1, allowed
    expect(a.done).toBe(false);
    expect(a.next.flipCount).toBe(1);
    const b = stepStaircase(a.next, 1, 5, 0, c); // too easy: flip 2 > 1
    expect(b.done).toBe(true);
    expect(b.reason).toBe('max-refinements');
  });

  it('an empty block (NaN rate) counts as on target, as in the original', () => {
    const r = stepStaircase(s0, 0, 0, 0, cal);
    expect(Number.isNaN(r.catchRate)).toBe(true);
    expect(r.done).toBe(true);
  });
});
