/**
 * The scene's procedural textures: the fire noise, the gravel and the classic look's yellow
 * flame. Everything is seamless (tileable) and deterministic. Pure functions returning RGBA bytes; renderer.ts turns them into textures.
 */

export interface Rgba {
  size: number;
  data: Uint8Array;
}

/** Integer hash of a lattice point, to [0, 1). */
function hash(ix: number, iy: number, seed: number): number {
  let h = (ix * 374761393 + iy * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const wrap = (i: number, period: number) => ((i % period) + period) % period;

/** Value noise on a lattice that repeats every `period` cells, with smoothstep interpolation. */
function valueNoise(x: number, y: number, period: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const x0 = wrap(ix, period);
  const x1 = wrap(ix + 1, period);
  const y0 = wrap(iy, period);
  const y1 = wrap(iy + 1, period);
  const a = hash(x0, y0, seed);
  const b = hash(x1, y0, seed);
  const c = hash(x0, y1, seed);
  const d = hash(x1, y1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/**
 * Fractal Brownian motion: octaves of value noise, each at double the frequency and half
 * the amplitude. (s, t) are in [0, 1) across the tile. `cells` is the lattice size of the
 * first octave, so the result tiles seamlessly. Range is about [0, 1].
 */
export function fbm(s: number, t: number, cells: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let period = cells;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(s * period, t * period, period, seed + o * 101);
    norm += amp;
    amp *= 0.5;
    period *= 2;
  }
  return sum / norm;
}

/** Distances to the nearest and second-nearest feature points of a tileable cellular (Worley) grid. */
function worley(s: number, t: number, cells: number, seed: number): [f1: number, f2: number, cellId: number] {
  const x = s * cells;
  const y = t * cells;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let f1 = Infinity;
  let f2 = Infinity;
  let id = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = wrap(ix + dx, cells);
      const cy = wrap(iy + dy, cells);
      const px = ix + dx + hash(cx, cy, seed);
      const py = iy + dy + hash(cx, cy, seed + 7);
      const d = Math.hypot(px - x, py - y);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = hash(cx, cy, seed + 13);
      } else if (d < f2) f2 = d;
    }
  }
  return [f1, f2, id];
}

function channelStats(values: Float32Array): { mean: number; sd: number } {
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / values.length;
  let sq = 0;
  for (const v of values) sq += (v - mean) ** 2;
  return { mean, sd: Math.sqrt(sq / values.length) };
}

/**
 * The noise texture the fire shader uses to distort flames. Two independent fBm fields in
 * R and G, rescaled to the statistics of the original's noise texture: the
 * shader's distortion depends on them, and G's mean above 0.5 pulls the flames down.
 */
export const C4_NOISE_STATS = { r: { mean: 0.448, sd: 0.18 }, g: { mean: 0.588, sd: 0.193 } } as const;

export function fireNoise(size = 256): Rgba {
  const n = size * size;
  const r = new Float32Array(n);
  const g = new Float32Array(n);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      r[y * size + x] = fbm(x / size, y / size, 8, 5, 11);
      g[y * size + x] = fbm(x / size, y / size, 8, 5, 29);
    }
  }
  const data = new Uint8Array(n * 4);
  const rs = channelStats(r);
  const gs = channelStats(g);
  const target = C4_NOISE_STATS;
  const to8 = (v: number, s: { mean: number; sd: number }, t: { mean: number; sd: number }) =>
    Math.round(Math.min(1, Math.max(0, t.mean + ((v - s.mean) * t.sd) / s.sd)) * 255);
  for (let i = 0; i < n; i++) {
    data[i * 4] = to8(r[i]!, rs, target.r);
    data[i * 4 + 1] = to8(g[i]!, gs, target.g);
    data[i * 4 + 2] = 0;
    data[i * 4 + 3] = 255;
  }
  return { size, data };
}

/**
 * The gravel on the ground, pit walls and poles: a packed layer
 * of small pebbles (cellular noise), each with its own grey-brown tint, dark gaps between
 * them, and fBm grit on top.
 */
export function gravel(size = 512): Rgba {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b] = gravelAt(x / size, y / size);
      const i = (y * size + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { size, data };
}

/** The gravel colour at (s, t) in the tile, as 0-255 RGB. Periodic: (s + 1, t) is the same point. */
export function gravelAt(s: number, t: number): [number, number, number] {
  const [f1, f2, id] = worley(s, t, 40, 3);
  const edge = Math.min(1, (f2 - f1) / 0.18); // 0 in the gaps between pebbles
  const grit = fbm(s, t, 64, 3, 5);
  const mottle = fbm(s, t, 6, 4, 17);
  const shade = (0.55 + 0.35 * id) * (0.35 + 0.65 * edge) * (0.8 + 0.4 * grit) * (0.85 + 0.3 * mottle);
  const warm = 0.9 + 0.2 * hash(Math.floor(id * 1e6), 0, 23);
  return [Math.min(255, Math.round(150 * shade * warm)), Math.min(255, Math.round(142 * shade)), Math.min(255, Math.round(128 * shade * (2 - warm)))];
}

/**
 * The classic look's yellow pit flame: red_flame,
 * recoloured from red to a yellow-white candle flame. Works in place on RGBA
 * pixels; alpha is kept.
 */
export function recolorToYellowFlame(pixels: Uint8ClampedArray | Uint8Array): void {
  for (let i = 0; i < pixels.length; i += 4) {
    const l = Math.max(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!) / 255;
    const core = l * l; // the brightest part goes towards white
    pixels[i] = Math.round(255 * Math.min(1, l * 1.1));
    pixels[i + 1] = Math.round(255 * Math.min(1, l * 0.78 + core * 0.3));
    pixels[i + 2] = Math.round(255 * Math.min(1, l * 0.3 + core * 0.45));
  }
}
