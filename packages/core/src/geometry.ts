/**
 * Scene layout in world units, with Z pointing up.
 *
 * Measured from the original binary assets (GTBallDrop_clean.wld, BallCatcher_RED.mdl,
 * GTBall_BLUE.mdl) by reading their node transforms and primitive sizes. Values marked
 * "approx" had to be inferred rather than read directly. See docs/FIDELITY.md.
 */
export const GEOMETRY = {
  laneCount: 7,
  /** x of lane 0 (far left on screen). Lanes are laneSpacing apart. */
  firstLaneX: -6,
  laneSpacing: 2,
  middleLane: 3,
  /** Locator y of both the catcher slots and the ball drops. */
  laneY: 1.5,
  /** z of the "Ball Drops" locators. */
  dropZ: 10.4,
  /** z of the "Paddle Slots" locators (the catcher's origin). */
  catcherZ: 0.2,
  ballRadius: 0.25,
  /** Horizontal ball-centre distance at which the ball touches the catcher ring (approx: ring r≈0.5 + ball r). */
  catchHalfWidth: 0.75,
  /** Ball-centre z range in which it can touch the catcher (approx: ring top ≈ z 0.38). */
  catchZMax: 0.63,
  catchZMin: -0.05,
  /** Ball-centre z at which the ball enters a "Fire Pit" burn trigger (box top z -0.5, minus the 0.25 trigger radius). */
  burnZ: -0.25,
  /** Ball-centre z at which the ball enters the kill trigger (box top z -2.5, approx). */
  killZ: -2.25,
  camera: { position: [0, -12, 4.9] as const, lookAt: [0, 0, 4.9] as const },
  /** The original ran at 1024x768. */
  displayAspect: 4 / 3,
} as const;

export function laneX(lane: number): number {
  return GEOMETRY.firstLaneX + lane * GEOMETRY.laneSpacing;
}

/**
 * The original's `_currColumn`, used in BALL_CATCHER_LEFT/RIGHT log lines. It runs from
 * +3 (far left) to -3 (far right): pressing left increments it.
 */
export function legacyColumn(lane: number): number {
  return GEOMETRY.middleLane - lane;
}
