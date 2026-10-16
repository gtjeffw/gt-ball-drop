import { describe, expect, it } from 'vitest';
import { ExperimentConfigSchema, resolveConfig, DEFAULT_CONFIG } from '@gtbd/protocol';
import { continuousX, normalize, PositionMapper, StepMapper } from '../src/axis-mapping';
import { hidAxes, isController, readField, type HidCollectionInfo } from '../src/hid';
import { describeMapping } from '../src/controller-panel';

const usage = (page: number, id: number) => (page << 16) | id;

/**
 * A typical USB joystick or wheel: report 1 holds 12 buttons, 4 bits of padding, a 16-bit
 * X declared with the "65535 reads as -1" quirk, a signed 8-bit Y, an 8-bit hat switch and
 * a 10-bit steering axis.
 */
const wheel: HidCollectionInfo[] = [
  {
    usagePage: 0x01,
    usage: 0x04,
    inputReports: [
      {
        reportId: 1,
        items: [
          { isRange: true, usageMinimum: usage(0x09, 1), usageMaximum: usage(0x09, 12), reportSize: 1, reportCount: 12, logicalMinimum: 0, logicalMaximum: 1, isAbsolute: true },
          { isConstant: true, reportSize: 4, reportCount: 1 },
          { usages: [usage(0x01, 0x30)], reportSize: 16, reportCount: 1, logicalMinimum: 0, logicalMaximum: -1, isAbsolute: true },
          { usages: [usage(0x01, 0x31)], reportSize: 8, reportCount: 1, logicalMinimum: -127, logicalMaximum: 127, isAbsolute: true },
          { usages: [usage(0x01, 0x39)], reportSize: 8, reportCount: 1, logicalMinimum: 0, logicalMaximum: 7, isAbsolute: true },
          { usages: [usage(0x02, 0xc8)], reportSize: 10, reportCount: 1, logicalMinimum: 0, logicalMaximum: 1023, isAbsolute: true },
        ],
      },
    ],
  },
];

describe('WebHID report layout', () => {
  it('finds the axes, their bit positions and ranges, skipping buttons, padding and the hat', () => {
    expect(hidAxes(wheel).map((a) => [a.label, a.bitOffset, a.bitSize, a.signed, a.logicalMin, a.logicalMax])).toEqual([
      ['X', 16, 16, false, 0, 65535],
      ['Y', 32, 8, true, -127, 127],
      ['Steering', 48, 10, false, 0, 1023],
    ]);
  });

  it('reads little-endian fields, signed and across byte boundaries', () => {
    const data = new DataView(new Uint8Array([0xff, 0x0f, 0x34, 0x12, 0x81, 0x05, 0xff, 0x02]).buffer);
    const [x, y, steering] = hidAxes(wheel);
    expect(readField(data, x!.bitOffset, x!.bitSize, x!.signed)).toBe(0x1234);
    expect(readField(data, y!.bitOffset, y!.bitSize, y!.signed)).toBe(-127);
    expect(readField(data, steering!.bitOffset, steering!.bitSize, steering!.signed)).toBe(0x2ff);
    expect(readField(data, 60, 8, false)).toBeNull(); // past the end of the report
  });

  it('keys repeated usages by occurrence, and takes each report once', () => {
    const twoSticks: HidCollectionInfo[] = [
      {
        usagePage: 0x01,
        usage: 0x05,
        inputReports: [{ reportId: 0, items: [{ usages: [usage(0x01, 0x30), usage(0x01, 0x31)], reportSize: 8, reportCount: 4, logicalMinimum: 0, logicalMaximum: 255 }] }],
        children: [{ inputReports: [{ reportId: 0, items: [{ usages: [usage(0x01, 0x30)], reportSize: 8, reportCount: 1 }] }] }],
      },
    ];
    // Four fields, two usages: the last usage repeats for the rest.
    expect(hidAxes(twoSticks).map((a) => [a.label, a.bitOffset])).toEqual([
      ['X', 0],
      ['Y', 8],
      ['Y 2', 16],
      ['Y 3', 24],
    ]);
  });

  it('recognises joysticks, gamepads and multi-axis controllers only', () => {
    expect(isController({ collections: wheel })).toBe(true);
    expect(isController({ collections: [{ usagePage: 0x01, usage: 0x02 }] })).toBe(false); // a mouse
  });
});

describe('axis mapping', () => {
  it('normalizes a raw range to −1..1, clamped, optionally inverted', () => {
    expect(normalize(0, 0, 1023, false)).toBe(-1);
    expect(normalize(1023, 0, 1023, false)).toBe(1);
    expect(normalize(2000, 0, 1023, false)).toBe(1);
    expect(normalize(256, 0, 1024, true)).toBeCloseTo(0.5);
  });

  it('continuous: −1..1 spans the outer lanes', () => {
    expect([continuousX(-1, 1), continuousX(0, 1), continuousX(0.5, 1), continuousX(1, 1)]).toEqual([-6, 0, 3, 6]);
  });

  it('reach: a shorter throw spans the lanes, and beyond it the paddle stays at the edge', () => {
    expect([continuousX(-0.5, 0.5), continuousX(0.25, 0.5), continuousX(0.5, 0.5), continuousX(0.9, 0.5)]).toEqual([-6, 3, 6, 6]);
    const m = new PositionMapper(7, 0.2, 0.5);
    expect([m.update(0.5), m.update(-0.5), m.update(0)]).toEqual([6, 0, 3]);
  });

  it('step: one move per push, re-armed only back inside the release band', () => {
    const m = new StepMapper({ stepThreshold: 0.5, stepRelease: 0.3 });
    const moves = [0, 0.4, 0.6, 0.9, 0.4, 0.6, 0.2, 0.7, -0.6, -0.9, 0].flatMap((v) => m.update(v));
    expect(moves).toEqual(['right', 'right', 'left']);
  });

  it('step: a jump straight across the centre releases and pushes in one reading', () => {
    const m = new StepMapper({ stepThreshold: 0.5, stepRelease: 0.3 });
    expect(m.update(0.8)).toEqual(['right']);
    expect(m.update(-0.8)).toEqual(['left']);
  });

  it('position: seven equal zones, with a margin before the lane changes', () => {
    const m = new PositionMapper(7, 0.2);
    const w = 2 / 7;
    expect(m.update(-1)).toBe(0);
    expect(m.update(1)).toBe(6);
    expect(m.update(0)).toBe(3);
    // Just into lane 4's zone: not far enough yet.
    expect(m.update(-1 + 4 * w + 0.1 * w)).toBe(3);
    expect(m.update(-1 + 4 * w + 0.3 * w)).toBe(4);
    // And back: lane 4 holds until 0.2 of a zone below its edge.
    expect(m.update(-1 + 4 * w - 0.1 * w)).toBe(4);
    expect(m.update(-1 + 4 * w - 0.3 * w)).toBe(3);
  });
});

describe('controller config', () => {
  it('describes each mode for the Experimenter panel', () => {
    const c = DEFAULT_CONFIG.controller;
    expect(describeMapping(c)).toMatch(/^In steps: push past 0.5 .* inside 0.3/);
    expect(describeMapping({ ...c, mapping: 'position' })).toMatch(/^By position, continuously.*Reach 1: the full travel spans the lanes\.$/);
    expect(describeMapping({ ...c, mapping: 'position', positionReach: 0.7 })).toMatch(/Reach 0.7: the outer lanes at 0.7 of full travel\.$/);
    expect(describeMapping({ ...c, mapping: 'position', positionMotion: 'lanes' })).toMatch(/^By position, in lanes: .*margin 0.2/);
  });


  it('defaults when absent, so older configs still load', () => {
    const { controller: _, ...old } = DEFAULT_CONFIG;
    expect(ExperimentConfigSchema.parse(old).controller).toEqual(DEFAULT_CONFIG.controller);
    expect(resolveConfig({ controller: { mapping: 'position' } }).controller).toEqual({ ...DEFAULT_CONFIG.controller, mapping: 'position' });
  });

  it('keeps the reach between 0.2 and 1', () => {
    expect(() => resolveConfig({ controller: { positionReach: 0.1 } })).toThrow();
    expect(resolveConfig({ controller: { positionReach: 0.6 } }).controller.positionReach).toBe(0.6);
  });

  it('rejects a release threshold at or above the push threshold', () => {
    expect(() => resolveConfig({ controller: { stepThreshold: 0.4, stepRelease: 0.4 } })).toThrow(/push threshold/);
  });
});
