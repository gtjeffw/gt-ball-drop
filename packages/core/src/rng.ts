/**
 * Seeded PRNG (sfc32). Its output differs from C4's Math::Random, but seeding makes
 * every session reproducible from its log.
 */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(readonly seed: number) {
    this.a = 0x9e3779b9;
    this.b = 0x243f6a88;
    this.c = 0xb7e15162;
    this.d = seed >>> 0;
    for (let i = 0; i < 15; i++) this.next();
  }

  /** Uniform [0, 1). */
  next(): number {
    this.a >>>= 0; this.b >>>= 0; this.c >>>= 0; this.d >>>= 0;
    let t = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) | 0;
    t = (t + this.d) | 0;
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }

  /** C4 Math::RandomFloat(max): uniform [0, max). */
  float(max: number): number {
    return this.next() * max;
  }

  /** C4 Math::Random(n): uniform integer [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
}

export function randomSeed(): number {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0]! >>> 0;
}
