import { describe, expect, it } from 'vitest';
import { C4_NOISE_STATS, fbm, fireNoise, gravel, gravelAt, recolorToYellowFlame } from '../src/procedural';

const stats = (img: { data: Uint8Array }, ch: number) => {
  const v: number[] = [];
  for (let i = ch; i < img.data.length; i += 4) v.push(img.data[i]! / 255);
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
  return { mean, sd };
};

describe('procedural textures', () => {
  it('fBm tiles seamlessly: the value at s = 1 equals the value at s = 0', () => {
    for (const t of [0, 0.13, 0.5, 0.91]) {
      expect(fbm(1, t, 8, 5, 3)).toBeCloseTo(fbm(0, t, 8, 5, 3), 12);
      expect(fbm(t, 1, 8, 5, 3)).toBeCloseTo(fbm(t, 0, 8, 5, 3), 12);
    }
  });

  it('fire noise matches the C4 noise texture statistics the fire shader depends on', () => {
    const img = fireNoise(128);
    const r = stats(img, 0);
    const g = stats(img, 1);
    expect(r.mean).toBeCloseTo(C4_NOISE_STATS.r.mean, 2);
    expect(g.mean).toBeCloseTo(C4_NOISE_STATS.g.mean, 2);
    expect(r.sd).toBeCloseTo(C4_NOISE_STATS.r.sd, 2);
    expect(g.sd).toBeCloseTo(C4_NOISE_STATS.g.sd, 2);
  });

  it('gravel is opaque and grey-brown, and tiles exactly', () => {
    const img = gravel(64);
    const c = stats(img, 0);
    expect(c.mean).toBeGreaterThan(0.2);
    expect(c.mean).toBeLessThan(0.7);
    expect(stats(img, 3).mean).toBe(1);
    for (const t of [0, 0.37, 0.8]) {
      expect(gravelAt(1, t)).toEqual(gravelAt(0, t));
      expect(gravelAt(t, 1)).toEqual(gravelAt(t, 0));
      expect(gravelAt(1 + t / 7, t)).toEqual(gravelAt(t / 7, t));
    }
  });

  it('recolouring red_flame keeps alpha and makes it yellow (R >= G >= B)', () => {
    const px = new Uint8Array([200, 40, 10, 128, 90, 20, 5, 255]);
    recolorToYellowFlame(px);
    expect(px[3]).toBe(128);
    expect(px[7]).toBe(255);
    for (const i of [0, 4]) {
      expect(px[i]!).toBeGreaterThanOrEqual(px[i + 1]!);
      expect(px[i + 1]!).toBeGreaterThanOrEqual(px[i + 2]!);
    }
  });
});
