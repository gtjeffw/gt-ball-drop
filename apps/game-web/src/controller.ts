import type { ControllerInfo } from '@gtbd/protocol';
import { normalize } from './axis-mapping';
import { CONTROLLER_FILTERS, hidAxes, isController, readField, webHid, type HidAxis, type HidDevice, type HidInputReportEvent } from './hid';

/**
 * Joysticks and steering wheels. Two ways to read one:
 *
 *  - WebHID (Chrome, Edge, the desktop app): the page gets every report the device sends,
 *    as an event with its own timestamp, so no movement is missed.
 *  - Gamepad API (any browser; the fallback): the page has to ask for the current state,
 *    here every GAMEPAD_POLL_MS, so a reading is timed to the poll and a movement that comes
 *    and goes between two polls is missed.
 *
 * Which device, which axis, invert and range belong to the computer, not the experiment,
 * so they are kept in this browser's storage rather than in config.json. Each session
 * records them (the `controller` event).
 */
const STORAGE_KEY = 'gtbd.controller';
/** Browsers don't run timers much faster than this. */
export const GAMEPAD_POLL_MS = 4;

export interface AxisDef {
  key: string;
  label: string;
  /** The device's own range for this axis. */
  min: number;
  max: number;
}

export interface Sample {
  /** −1 (left) to 1 (right), after range and invert. */
  value: number;
  raw: number;
  /** When the reading was taken, in the performance.now() timebase. */
  t: number;
}

/** A device the panel can offer. */
export interface Candidate {
  id: string;
  api: 'webhid' | 'gamepad';
  name: string;
}

interface Saved {
  api: 'webhid' | 'gamepad';
  name: string;
  vendorId: number | null;
  productId: number | null;
  axis: string | null;
  invert: boolean;
  range: { min: number; max: number } | null;
}

interface Source {
  readonly api: 'webhid' | 'gamepad';
  readonly name: string;
  readonly vendorId: number | null;
  readonly productId: number | null;
  readonly axes: AxisDef[];
  /** Readings received so far (WebHID: reports; Gamepad API: polls that found a change). */
  readonly readings: number;
  read(key: string): number | null;
  close(): void;
}

class WebHidSource implements Source {
  readonly api = 'webhid';
  readonly axes: AxisDef[];
  readings = 0;
  private readonly fields: HidAxis[];
  private readonly values = new Map<string, number>();

  private constructor(
    readonly device: HidDevice,
    private readonly onReading: (t: number) => void,
  ) {
    this.fields = hidAxes(device.collections);
    this.axes = this.fields.map((f) => ({ key: f.key, label: f.label, min: f.logicalMin, max: f.logicalMax }));
    device.addEventListener('inputreport', this.listener);
  }

  static async open(device: HidDevice, onReading: (t: number) => void): Promise<WebHidSource> {
    if (!device.opened) await device.open();
    return new WebHidSource(device, onReading);
  }

  get name() {
    return this.device.productName || `HID ${hex(this.device.vendorId)}:${hex(this.device.productId)}`;
  }
  get vendorId() {
    return this.device.vendorId;
  }
  get productId() {
    return this.device.productId;
  }

  read(key: string): number | null {
    return this.values.get(key) ?? null;
  }

  private readonly listener = (ev: Event) => {
    const e = ev as HidInputReportEvent;
    for (const f of this.fields) {
      if (f.reportId !== e.reportId) continue;
      const v = readField(e.data, f.bitOffset, f.bitSize, f.signed);
      if (v !== null) this.values.set(f.key, v);
    }
    this.readings++;
    this.onReading(e.timeStamp);
  };

  close(): void {
    this.device.removeEventListener('inputreport', this.listener);
    void this.device.close().catch(() => {});
  }
}

class GamepadSource implements Source {
  readonly api = 'gamepad';
  readonly axes: AxisDef[];
  readonly vendorId: number | null;
  readonly productId: number | null;
  readings = 0;
  private readonly values = new Map<string, number>();
  private last = -1;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly index: number,
    readonly name: string,
    axisCount: number,
    private readonly onReading: (t: number) => void,
  ) {
    this.axes = Array.from({ length: axisCount }, (_, i) => ({ key: `a${i}`, label: `Axis ${i}`, min: -1, max: 1 }));
    [this.vendorId, this.productId] = gamepadIds(name);
    this.timer = setInterval(() => this.poll(), GAMEPAD_POLL_MS);
  }

  read(key: string): number | null {
    return this.values.get(key) ?? null;
  }

  private poll(): void {
    const gp = navigator.getGamepads()[this.index];
    if (!gp || gp.id !== this.name || gp.timestamp === this.last) return;
    this.last = gp.timestamp;
    gp.axes.forEach((v, i) => this.values.set(`a${i}`, v));
    this.readings++;
    // The browser stamps each state with when it read the device. Use that if it's in the
    // same timebase as performance.now() (it should be, but browsers have differed).
    const now = performance.now();
    this.onReading(gp.timestamp <= now && gp.timestamp > now - 100 ? gp.timestamp : now);
  }

  close(): void {
    clearInterval(this.timer);
  }
}

/** Vendor and product IDs from a Gamepad id: Chrome "… (Vendor: 046d Product: c24f)", Firefox "046d-c24f-…". */
function gamepadIds(id: string): [number | null, number | null] {
  const m = /Vendor: ([0-9a-f]{4}) Product: ([0-9a-f]{4})/i.exec(id) ?? /^([0-9a-f]{1,4})-([0-9a-f]{1,4})-/i.exec(id);
  return m ? [parseInt(m[1]!, 16), parseInt(m[2]!, 16)] : [null, null];
}

const hex = (n: number) => n.toString(16).padStart(4, '0');

export type ControllerChange = { kind: 'connected' | 'disconnected'; info: ControllerInfo } | { kind: 'settings' | 'devices' | 'error' };

export class Controller {
  readonly webHidSupported = webHid() !== null;
  private source: Source | null = null;
  private saved: Saved | null = loadSaved();
  private hidDevices: HidDevice[] = [];
  private lastRaw: number | null = null;
  private connecting = 0;
  private readonly sampleListeners = new Set<(s: Sample) => void>();
  private readonly changeListeners = new Set<(c: ControllerChange) => void>();
  /** The last problem connecting, for the panel. */
  error: string | null = null;

  constructor() {
    const hid = webHid();
    hid?.addEventListener('connect', () => void this.refresh(true));
    hid?.addEventListener('disconnect', (ev) => {
      const device = (ev as unknown as { device: HidDevice }).device;
      if (this.source instanceof WebHidSource && this.source.device === device) this.drop();
      void this.refresh(false);
    });
    addEventListener('gamepadconnected', (ev) => {
      const gp = (ev as GamepadEvent).gamepad;
      if (!this.source && this.saved?.api === 'gamepad' && gp.id === this.saved.name) void this.connect(`gp:${gp.index}`);
      this.emitChange({ kind: 'devices' });
    });
    addEventListener('gamepaddisconnected', (ev) => {
      const gp = (ev as GamepadEvent).gamepad;
      if (this.source instanceof GamepadSource && this.source.name === gp.id) this.drop();
      this.emitChange({ kind: 'devices' });
    });
  }

  /** List the devices this page may use, and reconnect the one used last time if it's here. */
  async init(): Promise<void> {
    await this.refresh(true);
    if (!this.source && this.saved?.api === 'gamepad') {
      const gp = navigator.getGamepads().find((g) => g?.id === this.saved?.name);
      if (gp) await this.connect(`gp:${gp.index}`);
    }
  }

  private async refresh(reconnect: boolean): Promise<void> {
    this.hidDevices = ((await webHid()?.getDevices()) ?? []).filter(isController);
    if (reconnect && !this.source && this.saved?.api === 'webhid') {
      const s = this.saved;
      const i = this.hidDevices.findIndex((d) => d.vendorId === s.vendorId && d.productId === s.productId);
      if (i >= 0) await this.connect(`hid:${i}`);
    }
    this.emitChange({ kind: 'devices' });
  }

  candidates(): Candidate[] {
    const hid = this.hidDevices.map((d, i) => ({ id: `hid:${i}`, api: 'webhid' as const, name: d.productName || `HID ${hex(d.vendorId)}:${hex(d.productId)}` }));
    const pads = navigator
      .getGamepads()
      .filter((g): g is Gamepad => !!g)
      .map((g) => ({ id: `gp:${g.index}`, api: 'gamepad' as const, name: g.id }));
    return [...hid, ...pads];
  }

  /** The id of the connected device among candidates(), or '' for none. */
  get currentId(): string {
    const s = this.source;
    if (s instanceof WebHidSource) return this.hidDevices.includes(s.device) ? `hid:${this.hidDevices.indexOf(s.device)}` : '';
    if (s instanceof GamepadSource) return this.candidates().find((c) => c.api === 'gamepad' && c.name === s.name)?.id ?? '';
    return '';
  }

  /** Ask the browser for a WebHID device: it shows its own chooser (the desktop app shows a dialog). */
  async requestWebHid(): Promise<void> {
    const hid = webHid();
    if (!hid) return;
    try {
      const t0 = performance.now();
      const picked = await hid.requestDevice({ filters: CONTROLLER_FILTERS });
      // An answer faster than anyone could pick means no chooser was shown (some embedded
      // browsers have WebHID but no chooser). A cancelled chooser also answers with nothing.
      if (!picked.length && performance.now() - t0 < 300) {
        this.error =
          "This browser didn't show a device chooser, so it can't read controllers through WebHID. Press a button on the controller to use it through the Gamepad API instead, or use Chrome, Edge or the desktop app.";
        this.emitChange({ kind: 'error' });
        return;
      }
      await this.refresh(false);
      const i = picked[0] ? this.hidDevices.indexOf(picked[0]) : -1;
      if (i >= 0) await this.connect(`hid:${i}`);
    } catch (err) {
      this.fail(err);
    }
  }

  /** Connect a candidate, or disconnect with ''. Settings carry over if it's the device used last time. */
  async connect(id: string): Promise<void> {
    const attempt = ++this.connecting;
    this.drop();
    this.error = null;
    if (!id) {
      this.saved = null;
      saveSettings(null);
      this.emitChange({ kind: 'settings' });
      return;
    }
    let source: Source;
    try {
      const [api, n] = id.split(':') as ['hid' | 'gp', string];
      if (api === 'hid') {
        const device = this.hidDevices[Number(n)];
        if (!device) return;
        source = await WebHidSource.open(device, (t) => this.onReading(t));
      } else {
        const gp = navigator.getGamepads()[Number(n)];
        if (!gp) return;
        source = new GamepadSource(gp.index, gp.id, gp.axes.length, (t) => this.onReading(t));
      }
    } catch (err) {
      this.fail(err);
      return;
    }
    if (attempt !== this.connecting) {
      source.close();
      return;
    }
    this.source = source;
    const same = this.saved?.api === source.api && this.saved.vendorId === source.vendorId && this.saved.productId === source.productId && this.saved.name === source.name;
    if (!same || !source.axes.some((a) => a.key === this.saved?.axis)) {
      const steering = source.axes.find((a) => a.label.startsWith('Steering'));
      this.saved = { api: source.api, name: source.name, vendorId: source.vendorId, productId: source.productId, axis: (steering ?? source.axes[0])?.key ?? null, invert: false, range: null };
    }
    saveSettings(this.saved);
    this.emitChange({ kind: 'connected', info: this.info! });
  }

  /** Stop reading the current device (it stays the one to reconnect to). */
  private drop(): void {
    const info = this.info;
    this.source?.close();
    this.source = null;
    this.lastRaw = null;
    if (info) this.emitChange({ kind: 'disconnected', info });
  }

  private fail(err: unknown): void {
    // The chooser was closed without picking a device: not an error.
    if (err instanceof DOMException && err.name === 'NotFoundError') return;
    this.error = err instanceof Error ? err.message : String(err);
    this.emitChange({ kind: 'error' });
  }

  get connected(): boolean {
    return this.source !== null;
  }

  get api(): 'webhid' | 'gamepad' | null {
    return this.source?.api ?? null;
  }

  get readings(): number {
    return this.source?.readings ?? 0;
  }

  axes(): AxisDef[] {
    return this.source?.axes ?? [];
  }

  get axisKey(): string | null {
    return this.source ? (this.saved?.axis ?? null) : null;
  }

  get invert(): boolean {
    return this.saved?.invert ?? false;
  }

  get range(): { min: number; max: number } | null {
    return this.saved?.range ?? null;
  }

  setAxis(key: string): void {
    this.update({ axis: key, range: null });
  }

  setInvert(invert: boolean): void {
    this.update({ invert });
  }

  setRange(range: { min: number; max: number } | null): void {
    this.update({ range });
  }

  private update(patch: Partial<Saved>): void {
    if (!this.saved) return;
    this.saved = { ...this.saved, ...patch };
    this.lastRaw = null;
    saveSettings(this.saved);
    this.emitChange({ kind: 'settings' });
  }

  /** The latest raw reading of an axis. */
  read(key: string): number | null {
    return this.source?.read(key) ?? null;
  }

  /** The selected axis now, −1 to 1, or null if nothing has been read yet. */
  get value(): number | null {
    const raw = this.raw;
    return raw === null ? null : this.normalize(raw);
  }

  get raw(): number | null {
    const key = this.axisKey;
    return key === null ? null : this.read(key);
  }

  /** What a session records about the device. */
  get info(): ControllerInfo | null {
    const s = this.source;
    if (!s || !this.saved) return null;
    return {
      api: s.api,
      name: s.name,
      vendorId: s.vendorId,
      productId: s.productId,
      axis: s.axes.find((a) => a.key === this.saved?.axis)?.label ?? 'none',
      invert: this.saved.invert,
      range: this.saved.range,
    };
  }

  onSample(cb: (s: Sample) => void): () => void {
    this.sampleListeners.add(cb);
    return () => this.sampleListeners.delete(cb);
  }

  onChange(cb: (c: ControllerChange) => void): () => void {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  private normalize(raw: number): number {
    const def = this.source?.axes.find((a) => a.key === this.saved?.axis);
    const r = this.saved?.range ?? def ?? { min: -1, max: 1 };
    return normalize(raw, r.min, r.max, this.saved?.invert ?? false);
  }

  private onReading(t: number): void {
    const raw = this.raw;
    if (raw === null || raw === this.lastRaw) return;
    this.lastRaw = raw;
    const s = { value: this.normalize(raw), raw, t };
    for (const cb of this.sampleListeners) cb(s);
  }

  private emitChange(c: ControllerChange): void {
    for (const cb of this.changeListeners) cb(c);
  }
}

function loadSaved(): Saved | null {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Saved | null;
  } catch {
    return null;
  }
}

function saveSettings(s: Saved | null): void {
  if (s) localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  else localStorage.removeItem(STORAGE_KEY);
}
