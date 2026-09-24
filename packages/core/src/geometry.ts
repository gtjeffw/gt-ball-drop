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
  /** 8 cylinders at the lane edges: r 0.1, rising 200 units from z 0. */
  dividers: { y: 2, radius: 0.1, height: 200 },
  /** 8 thin boxes between the fire pits: x from lane edge - 0.1, 0.2 wide, y -0.3..2.0, z -257.6..0. */
  pitWalls: { width: 0.2, yMin: -0.3, yMax: 2.0, zMin: -257.6, zMax: 0 },
  /** The ground: a 1000 x 1000 x 34.2 box at (-500, 2, -34.2), so its top face is the floor at z 0, from y 2 back. */
  ground: { xMin: -500, xMax: 500, yMin: 2, yMax: 1002, zTop: 0 },
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
