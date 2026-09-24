/**
 * Port of GTBallDrop/Spring.cpp: a damped spring integrated with RK4, used to ease the
 * catcher between lanes. Time is in seconds.
 */
const POS_STOP_THRESH = 0.01;
const VEL_STOP_THRESH = 0.01;

export class Spring {
  pos: number;
  vel: number;
  private b: number;
  private criticalDamping = false;
  private readonly maxAbsAmplitude: number;

  constructor(initPos: number, initVel: number, readonly k: number, b: number, readonly m: number, maxAbsAmplitude: number) {
    this.pos = initPos;
    this.vel = initVel;
    this.b = b;
    this.maxAbsAmplitude = maxAbsAmplitude;
  }

  setDampingCritical(): void {
    this.b = 2 * this.m * Math.sqrt(this.k / this.m);
    this.criticalDamping = true;
  }

  get damping(): number {
    return this.b;
  }

  isStopped(): boolean {
    return this.pos === 0 && this.vel === 0;
  }

  stop(): void {
    this.pos = 0;
    this.vel = 0;
  }

  setPosition(p: number): void {
    // Same clamp as the original: an over-range value becomes +max, whatever its sign.
    this.pos = this.maxAbsAmplitude > 0 && Math.abs(p) > this.maxAbsAmplitude ? this.maxAbsAmplitude : p;
  }

  /** Spring::Boing_dt */
  step(delta: number): void {
    if (!this.isStopped()) {
      if (delta <= 0) delta = 0.1;
      else if (delta > 0.5) delta = 0.5;

      const wasOnLeft = this.pos < 0;
      const [p, v] = rk4(this.pos, this.vel, delta, this.k, this.b, this.m);
      this.pos = p;
      this.vel = v;

      let halt = false;
      if (this.criticalDamping && wasOnLeft !== this.pos < 0) halt = true;
      if (Math.abs(this.pos) <= POS_STOP_THRESH && Math.abs(this.vel) <= VEL_STOP_THRESH) halt = true;
      if (halt) this.stop();
    }
  }
}

function rk4(x0: number, v0: number, dt: number, k: number, b: number, m: number): [number, number] {
  const acc = (x: number, v: number) => (k * -x - b * v) / m;
  const h = dt / 2;
  const ax = v0, av = acc(x0, v0);
  const bx = v0 + av * h, bv = acc(x0 + ax * h, v0 + av * h);
  const cx = v0 + bv * h, cv = acc(x0 + bx * h, v0 + bv * h);
  const dx = v0 + cv * dt, dv = acc(x0 + cx * dt, v0 + cv * dt);
  return [x0 + ((ax + 2 * bx + 2 * cx + dx) * dt) / 6, v0 + ((av + 2 * bv + 2 * cv + dv) * dt) / 6];
}
