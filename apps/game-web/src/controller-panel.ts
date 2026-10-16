import { GEOMETRY, laneX } from '@gtbd/core';
import type { ControllerConfig } from '@gtbd/protocol';
import { continuousX, PositionMapper, StepMapper } from './axis-mapping';
import { GAMEPAD_POLL_MS, type Controller } from './controller';

const POLLED_TIMING = `the page has to ask the controller for its state, here every ${GAMEPAD_POLL_MS} ms, so
  paddle moves are timed to within about ${GAMEPAD_POLL_MS}–16 ms instead of to the report, and a very quick
  movement that comes and goes between two readings is missed. Sessions record which method was used.`;

/** Chosen device read through the Gamepad API although WebHID is available. */
const POLLED_WARNING = `<b>Lower timing quality: Gamepad API (polled).</b> With it, ${POLLED_TIMING} If the device is
  listed as WebHID, or <b>Connect a controller…</b> offers it, use that instead.`;

/** No WebHID in this browser at all. */
const NO_WEBHID_WARNING = `<b>Lower timing quality: this browser has no WebHID</b>, so controllers can only be read
  through the Gamepad API: ${POLLED_TIMING} For report-by-report timing use Chrome or Edge, or the desktop app.`;

/**
 * The experimenter's controller settings for this computer: which device, which axis,
 * invert, and range, with a live meter showing where the axis is and what it would do.
 * Shown on the browser-mode setup screen and in the start screen's Experimenter panel.
 */
export class ControllerPanel {
  private el: HTMLElement | null = null;
  private mapping: () => ControllerConfig | null = () => null;
  /** Where the mapping is set, when it can't be changed next to the panel (shown with it). */
  private mappingSource: string | null = null;
  private looping = false;
  /** Detecting the axis: each axis's reading when Detect was clicked. */
  private detect: Map<string, number | null> | null = null;
  /** Setting the range: the extremes seen so far. */
  private ranging: { min: number; max: number } | null = null;
  private preview: { key: string; step: StepMapper; position: PositionMapper } | null = null;
  private rate = { readings: 0, at: 0, perSecond: 0 };

  constructor(private readonly controller: Controller) {
    controller.onChange(() => this.render());
  }

  /**
   * Draw into `el`. `mapping` gives the mapping settings to preview (null if they're
   * invalid). With `mappingSource`, the panel also says what the mapping is and where it's set.
   */
  mount(el: HTMLElement, mapping: () => ControllerConfig | null, mappingSource: string | null = null): void {
    this.el = el;
    this.mapping = mapping;
    this.mappingSource = mappingSource;
    this.render();
    if (!this.looping) {
      this.looping = true;
      requestAnimationFrame(this.tick);
    }
  }

  private render(): void {
    const el = this.el;
    if (!el?.isConnected) return;
    const c = this.controller;
    const candidates = c.candidates();
    const current = c.currentId;
    const devices = [
      `<option value="">None: keyboard only</option>`,
      ...candidates.map(
        (d) => `<option value="${d.id}"${d.id === current ? ' selected' : ''}>${esc(d.name)} (${d.api === 'webhid' ? 'WebHID' : 'Gamepad API, polled'})</option>`,
      ),
    ].join('');
    const warning = !c.webHidSupported ? NO_WEBHID_WARNING : c.api === 'gamepad' ? POLLED_WARNING : '';
    const hint =
      candidates.length === 0
        ? c.webHidSupported
          ? 'No controller yet. Plug one in and click <b>Connect a controller…</b>, or press a button on it.'
          : 'No controller yet. Plug one in and press a button on it, so the browser lists it.'
        : '';

    let settings = '';
    if (c.connected) {
      const axes = c
        .axes()
        .map((a) => `<option value="${esc(a.key)}"${a.key === c.axisKey ? ' selected' : ''}>${esc(a.label)}</option>`)
        .join('');
      // The range is the device's physical extents: as it reports them, or as calibrated
      // when it doesn't reach them. How much of it a participant uses is the experiment's reach.
      const r = c.range;
      const reported = c.axes().find((a) => a.key === c.axisKey);
      const rangeText = r ? `calibrated, ${fmt(r.min)} to ${fmt(r.max)}` : reported ? `as reported, ${fmt(reported.min)} to ${fmt(reported.max)}` : 'as reported';
      settings = `
        <div class="ctl-row"><span>Axis</span><select data-ctl="axis">${axes}</select>
          <button type="button" data-ctl="detect">${this.detect ? 'Cancel' : 'Detect'}</button>
          <label class="ctl-check"><input type="checkbox" data-ctl="invert"${c.invert ? ' checked' : ''} /> Invert</label></div>
        <div class="ctl-row"><span>Range</span><span class="ctl-range">${rangeText}</span>
          <button type="button" data-ctl="range">${this.ranging ? 'Done' : 'Calibrate…'}</button>
          ${r && !this.ranging ? '<button type="button" data-ctl="full">Use reported</button>' : ''}</div>
        <div class="ctl-track"><div class="ctl-zones"></div><div class="ctl-marker"></div></div>
        <p class="ctl-status"></p>`;
    }

    const m = this.mapping();
    const mode = this.mappingSource && m ? `<p class="ctl-mode"><b>Mode:</b> ${describeMapping(m)} <span>(${esc(this.mappingSource)})</span></p>` : '';

    el.innerHTML = `
      <div class="controller">
        ${mode}
        <div class="ctl-row"><span>Device</span><select data-ctl="device">${devices}</select>
          ${c.webHidSupported ? '<button type="button" data-ctl="request">Connect a controller…</button>' : ''}</div>
        ${hint ? `<p class="ctl-hint">${hint}</p>` : ''}
        ${c.error ? `<p class="ctl-error">${esc(c.error)}</p>` : ''}
        ${warning ? `<p class="warn-box">${warning}</p>` : ''}
        ${settings}
      </div>`;
    this.preview = null;

    const q = <T extends HTMLElement>(sel: string) => el.querySelector<T>(`[data-ctl="${sel}"]`);
    q<HTMLSelectElement>('device')?.addEventListener('change', (ev) => {
      this.detect = this.ranging = null;
      void c.connect((ev.target as HTMLSelectElement).value);
    });
    q('request')?.addEventListener('click', () => void c.requestWebHid());
    q<HTMLSelectElement>('axis')?.addEventListener('change', (ev) => c.setAxis((ev.target as HTMLSelectElement).value));
    q<HTMLInputElement>('invert')?.addEventListener('change', (ev) => c.setInvert((ev.target as HTMLInputElement).checked));
    q('detect')?.addEventListener('click', () => {
      this.detect = this.detect ? null : new Map(c.axes().map((a) => [a.key, c.read(a.key)]));
      this.render();
    });
    q('range')?.addEventListener('click', () => {
      const r = this.ranging;
      this.ranging = r ? null : { min: Infinity, max: -Infinity };
      if (r && r.max > r.min) c.setRange(r);
      else this.render();
    });
    q('full')?.addEventListener('click', () => c.setRange(null));
  }

  private readonly tick = (now: number) => {
    if (!this.el?.isConnected) {
      this.looping = false;
      return;
    }
    this.updateLive(now);
    requestAnimationFrame(this.tick);
  };

  private updateLive(now: number): void {
    const el = this.el!;
    const c = this.controller;
    if (!c.connected) return;

    if (this.detect) {
      for (const a of c.axes()) {
        const v = c.read(a.key);
        if (v === null) continue;
        const base = this.detect.get(a.key) ?? null;
        if (base === null) this.detect.set(a.key, v);
        else if (Math.abs(v - base) > 0.3 * (a.max - a.min)) {
          this.detect = null;
          c.setAxis(a.key);
          return;
        }
      }
    }
    const raw = c.raw;
    if (this.ranging && raw !== null) {
      this.ranging.min = Math.min(this.ranging.min, raw);
      this.ranging.max = Math.max(this.ranging.max, raw);
    }

    if (now - this.rate.at >= 500) {
      this.rate.perSecond = this.rate.at ? Math.round(((c.readings - this.rate.readings) * 1000) / (now - this.rate.at)) : 0;
      this.rate.readings = c.readings;
      this.rate.at = now;
    }

    // What the mapping would do with this reading.
    const m = this.mapping();
    const key = JSON.stringify(m);
    if (m && this.preview?.key !== key) {
      this.preview = { key, step: new StepMapper(m), position: new PositionMapper(GEOMETRY.laneCount, m.positionHysteresis, m.positionReach) };
      const zones = el.querySelector('.ctl-zones');
      if (zones) zones.innerHTML = m.mapping === 'position' ? '<i></i>'.repeat(GEOMETRY.laneCount) : `<i style="flex: ${1 - m.stepThreshold}"></i><i style="flex: ${2 * m.stepThreshold}"></i><i style="flex: ${1 - m.stepThreshold}"></i>`;
    }
    const v = c.value;
    const marker = el.querySelector<HTMLElement>('.ctl-marker');
    if (marker) {
      marker.hidden = v === null;
      if (v !== null) marker.style.left = `${((v + 1) / 2) * 100}%`;
    }
    const cells = el.querySelectorAll('.ctl-zones i');
    if (m && v !== null && this.preview) {
      // Continuous: the lane whose ball the paddle would catch there, if any. Lanes: the
      // lane. Step: the left or right band while it's held.
      let lit: number;
      if (m.mapping === 'position' && m.positionMotion === 'continuous') {
        const x = continuousX(v, m.positionReach);
        const nearest = Math.round((x - GEOMETRY.firstLaneX) / GEOMETRY.laneSpacing);
        lit = Math.abs(x - laneX(nearest)) < GEOMETRY.catchHalfWidth ? nearest : -1;
      } else if (m.mapping === 'position') lit = this.preview.position.update(v);
      else {
        this.preview.step.update(v);
        const held = this.preview.step.state;
        lit = held === 'left' ? 0 : held === 'right' ? 2 : -1;
      }
      cells.forEach((cell, i) => cell.classList.toggle('lit', i === lit));
    }

    const status = el.querySelector('.ctl-status');
    if (status) {
      status.textContent = this.detect
        ? 'Detecting: move the stick, or turn the wheel, as far as it goes…'
        : this.ranging
          ? `Calibrating: move the stick or wheel as far as it goes to the left and to the right, then click Done. Seen so far: ${
              this.ranging.max >= this.ranging.min ? `${fmt(this.ranging.min)} to ${fmt(this.ranging.max)}` : 'nothing yet'
            }.`
          : `${v === null ? 'Waiting for the first reading. ' : `Reading ${fmt(c.raw!)} → ${v.toFixed(2)}. `}${
              c.api === 'webhid' ? `WebHID: every report, ${this.rate.perSecond} reports/s.` : `Gamepad API: polled every ${GAMEPAD_POLL_MS} ms, ${this.rate.perSecond} changes/s.`
            }`;
    }
  }
}

/** The mapping in words, for the experimenter. */
export function describeMapping(m: ControllerConfig): string {
  if (m.mapping === 'step') return `In steps: push past ${m.stepThreshold} of full travel to move one lane, back inside ${m.stepRelease} to re-arm.`;
  const reach = m.positionReach < 1 ? ` Reach ${m.positionReach}: the outer lanes at ${m.positionReach} of full travel.` : ' Reach 1: the full travel spans the lanes.';
  return m.positionMotion === 'continuous'
    ? `By position, continuously: the paddle follows the axis with no spring, and the arrow keys don't move it.${reach}`
    : `By position, in lanes: the paddle springs to the lane the axis points at (margin ${m.positionHysteresis} of a lane), and the arrow keys don't move it.${reach}`;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(3);
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
