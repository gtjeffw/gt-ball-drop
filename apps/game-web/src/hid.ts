/**
 * WebHID: the parts this app uses (TypeScript's DOM library doesn't include WebHID), and
 * finding the axes in a device's input reports from the report descriptor the browser
 * parsed for us.
 *
 * Usages here are WebHID's "extended" usages: usage page in the high 16 bits, usage ID in
 * the low 16.
 */
export interface HidReportItem {
  isAbsolute?: boolean;
  isArray?: boolean;
  isConstant?: boolean;
  isRange?: boolean;
  usages?: number[];
  usageMinimum?: number;
  usageMaximum?: number;
  reportSize?: number;
  reportCount?: number;
  logicalMinimum?: number;
  logicalMaximum?: number;
}

export interface HidReportInfo {
  reportId?: number;
  items?: HidReportItem[];
}

export interface HidCollectionInfo {
  usagePage?: number;
  usage?: number;
  children?: HidCollectionInfo[];
  inputReports?: HidReportInfo[];
}

export interface HidDevice extends EventTarget {
  readonly opened: boolean;
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
  readonly collections: HidCollectionInfo[];
  open(): Promise<void>;
  close(): Promise<void>;
}

export interface HidInputReportEvent extends Event {
  readonly device: HidDevice;
  readonly reportId: number;
  readonly data: DataView;
}

export interface Hid extends EventTarget {
  getDevices(): Promise<HidDevice[]>;
  requestDevice(options: { filters: { usagePage?: number; usage?: number }[] }): Promise<HidDevice[]>;
}

export function webHid(): Hid | null {
  return typeof navigator !== 'undefined' && 'hid' in navigator ? (navigator as unknown as { hid: Hid }).hid : null;
}

const GENERIC_DESKTOP = 0x01;
const SIMULATION = 0x02;

/** Top-level collections that are game controllers: joystick, gamepad, multi-axis controller. */
export const CONTROLLER_FILTERS = [0x04, 0x05, 0x08].map((usage) => ({ usagePage: GENERIC_DESKTOP, usage }));

export function isController(device: { collections: HidCollectionInfo[] }): boolean {
  return device.collections.some((c) => c.usagePage === GENERIC_DESKTOP && CONTROLLER_FILTERS.some((f) => f.usage === c.usage));
}

const AXIS_NAMES = new Map<number, string>([
  [(GENERIC_DESKTOP << 16) | 0x30, 'X'],
  [(GENERIC_DESKTOP << 16) | 0x31, 'Y'],
  [(GENERIC_DESKTOP << 16) | 0x32, 'Z'],
  [(GENERIC_DESKTOP << 16) | 0x33, 'Rx'],
  [(GENERIC_DESKTOP << 16) | 0x34, 'Ry'],
  [(GENERIC_DESKTOP << 16) | 0x35, 'Rz'],
  [(GENERIC_DESKTOP << 16) | 0x36, 'Slider'],
  [(GENERIC_DESKTOP << 16) | 0x37, 'Dial'],
  [(GENERIC_DESKTOP << 16) | 0x38, 'Wheel'],
  [(SIMULATION << 16) | 0xba, 'Rudder'],
  [(SIMULATION << 16) | 0xbb, 'Throttle'],
  [(SIMULATION << 16) | 0xc4, 'Accelerator'],
  [(SIMULATION << 16) | 0xc5, 'Brake'],
  [(SIMULATION << 16) | 0xc8, 'Steering'],
]);

/** One axis field in an input report. */
export interface HidAxis {
  /** Stable across reconnects of the same device: report, usage, and which occurrence. */
  key: string;
  label: string;
  reportId: number;
  bitOffset: number;
  bitSize: number;
  signed: boolean;
  logicalMin: number;
  logicalMax: number;
}

/**
 * The absolute axes in a device's input reports, in report order. Bit offsets count from
 * the start of the report data, which in WebHID excludes the report ID byte.
 */
export function hidAxes(collections: HidCollectionInfo[]): HidAxis[] {
  // Browsers list a report's items under its top-level collection, so take the first
  // non-empty list for each report ID, top level first.
  const reports = new Map<number, HidReportItem[]>();
  const walk = (c: HidCollectionInfo) => {
    for (const r of c.inputReports ?? []) {
      const id = r.reportId ?? 0;
      if (!reports.has(id) && r.items?.length) reports.set(id, r.items);
    }
    for (const child of c.children ?? []) walk(child);
  };
  for (const c of collections) walk(c);

  const axes: HidAxis[] = [];
  const seen = new Map<string, number>();
  for (const [reportId, items] of reports) {
    let offset = 0;
    for (const item of items) {
      const size = item.reportSize ?? 0;
      const count = item.reportCount ?? 0;
      const usable = !item.isConstant && !item.isArray && item.isAbsolute !== false && size > 1;
      for (let i = 0; usable && i < count; i++) {
        const usage = usageAt(item, i);
        const name = usage === null ? undefined : AXIS_NAMES.get(usage);
        if (name === undefined) continue;
        const n = seen.get(`${reportId}:${usage}`) ?? 0;
        seen.set(`${reportId}:${usage}`, n + 1);
        let min = item.logicalMinimum ?? 0;
        let max = item.logicalMaximum ?? (1 << size) - 1;
        // A common descriptor quirk: an unsigned maximum such as 65535 written in as many
        // bytes as the field, which reads back as negative (-1).
        if (max < min) max += 2 ** size;
        axes.push({
          key: `${reportId}:${usage!.toString(16)}:${n}`,
          label: `${name}${n ? ` ${n + 1}` : ''}${reports.size > 1 ? ` (report ${reportId})` : ''}`,
          reportId,
          bitOffset: offset + i * size,
          bitSize: size,
          signed: min < 0,
          logicalMin: min,
          logicalMax: max,
        });
      }
      offset += size * count;
    }
  }
  return axes;
}

function usageAt(item: HidReportItem, i: number): number | null {
  if (item.isRange) {
    if (item.usageMinimum === undefined) return null;
    return Math.min(item.usageMinimum + i, item.usageMaximum ?? item.usageMinimum + i);
  }
  const u = item.usages ?? [];
  return u[Math.min(i, u.length - 1)] ?? null;
}

/** A little-endian bit field from a report, or null if the report is too short. */
export function readField(data: DataView, bitOffset: number, bitSize: number, signed: boolean): number | null {
  if (bitOffset + bitSize > data.byteLength * 8) return null;
  let value = 0;
  for (let b = 0; b < bitSize; b++) {
    const bit = bitOffset + b;
    if (data.getUint8(bit >> 3) & (1 << (bit & 7))) value += 2 ** b;
  }
  if (signed && value >= 2 ** (bitSize - 1)) value -= 2 ** bitSize;
  return value;
}
