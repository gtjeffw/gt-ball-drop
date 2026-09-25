import { DEFAULT_CONFIG, ExperimentConfigSchema, resolveConfig, type AppearanceConfig, type ExperimentConfig } from '@gtbd/protocol';
import { PRESETS } from './presets';

/**
 * Browser mode's setup screen, for the experimenter: every setting from config.json,
 * validated by the same schema, with presets, and load/save of a config.json file. The
 * remote-control settings are left out (browser mode has no host to receive commands).
 */
type Kind = 'int' | 'number' | 'bool' | 'text' | 'optional-int' | { options: [value: string, label: string][] };

interface Field {
  path: string;
  label: string;
  kind: Kind;
  step?: number;
  hint?: (c: ExperimentConfig) => string;
  /** Shown only when this returns true. */
  when?: (c: ExperimentConfig) => boolean;
}

const calibrating = (c: ExperimentConfig) => c.calibration.enabled;

const SECTIONS: { title: string; fields: Field[] }[] = [
  {
    title: 'Session',
    fields: [
      { path: 'defaultParticipantId', label: 'Participant ID (pre-filled)', kind: 'text' },
      { path: 'numBlocks', label: 'Blocks', kind: 'int' },
      { path: 'numTrials', label: 'Balls per block', kind: 'int', hint: () => 'caught + missed' },
      { path: 'onlyCreateNumTrialsBalls', label: 'Drop exactly that many balls', kind: 'bool' },
    ],
  },
  {
    title: 'Balls',
    fields: [
      { path: 'ballSpeed', label: 'Speed (units/ms)', kind: 'number', step: 0.0005, hint: (c) => `≈ ${(9.8 / c.ballSpeed / 1000).toFixed(1)} s to fall` },
      { path: 'ballSpawnTimeMs', label: 'Time between drops (ms)', kind: 'int', step: 50 },
      { path: 'dropMode', label: 'Drop pattern', kind: { options: [['lane', 'Lane (drifts one lane at a time)'], ['neighborhood', 'Neighborhood (jumps nearby)'], ['random', 'Random (any lane)']] } },
      { path: 'laneNeighborhoodSize', label: 'Neighborhood size', kind: 'int', when: (c) => c.dropMode === 'neighborhood' },
      {
        path: 'laneChangeStayChance',
        label: 'Chance to stay in the lane (%)',
        kind: 'number',
        step: 1,
        when: (c) => c.dropMode !== 'random',
      },
    ],
  },
  {
    title: 'Difficulty calibration',
    fields: [
      { path: 'calibration.enabled', label: 'Calibrate before the blocks', kind: 'bool' },
      { path: 'calibration.startWithPractice', label: 'Start with a practice block', kind: 'bool', when: calibrating },
      { path: 'calibration.numTrials', label: 'Balls per calibration block', kind: 'int', when: calibrating },
      { path: 'calibration.targetAvg', label: 'Target catch rate', kind: 'number', step: 0.05, when: calibrating },
      { path: 'calibration.targetAvgErr', label: 'Tolerance (±)', kind: 'number', step: 0.01, when: calibrating },
      { path: 'calibration.speedIncr', label: 'First speed step', kind: 'number', step: 0.0005, when: calibrating },
      { path: 'calibration.speedMin', label: 'Slowest speed', kind: 'number', step: 0.0005, when: calibrating },
      { path: 'calibration.spawnTimeIncrMs', label: 'First drop-interval step (ms)', kind: 'int', step: 10, when: calibrating },
      { path: 'calibration.spawnTimeMinMs', label: 'Shortest drop interval (ms)', kind: 'int', step: 10, when: calibrating },
      { path: 'calibration.maxRefinements', label: 'Direction changes allowed', kind: 'int', when: calibrating },
      { path: 'calibration.autoContinueMs', label: 'Break auto-continue (ms, 0 = wait)', kind: 'int', step: 500, when: calibrating },
    ],
  },
  {
    title: 'Look',
    fields: [
      { path: 'appearance.world', label: 'Scene', kind: { options: [['classic', 'Classic (cloudy sky)'], ['clean', 'Clean (pale background)']] } },
      { path: 'appearance.flameHeightScale', label: 'Flame height (1 = full)', kind: 'number', step: 0.1 },
      { path: 'appearance.flameOpacity', label: 'Flame brightness (0–1)', kind: 'number', step: 0.1 },
      { path: 'appearance.modelShading', label: 'Ball and paddle shading (0–1)', kind: 'number', step: 0.1 },
    ],
  },
  {
    title: 'Advanced',
    fields: [{ path: 'seed', label: 'Random seed (blank = new each session)', kind: 'optional-int' }],
  },
];

function get(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj);
}

function set(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = (o[k] ??= {}) as Record<string, unknown>;
  const last = keys[keys.length - 1]!;
  if (value === undefined) delete o[last];
  else o[last] = value;
}

/** Browser mode never takes remote commands. */
export function forBrowserMode(c: ExperimentConfig): ExperimentConfig {
  return { ...c, remoteControl: { enabled: false, infiniteTrials: false, infiniteBlocks: false } };
}

export class SetupScreen {
  private draft: Record<string, unknown> = {};
  private appearanceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Whether the browser agreed to keep our storage (null: no answer yet). */
  private storagePersistent: boolean | null = null;

  constructor(
    private readonly el: HTMLElement,
    private readonly handlers: {
      onContinue(config: ExperimentConfig): void;
      /** The look changed: redraw the scene behind the form. */
      onAppearance(appearance: AppearanceConfig): void;
    },
  ) {}

  setStorage(persistent: boolean): void {
    this.storagePersistent = persistent;
    const el = this.el.querySelector('.setup .storage');
    if (el) el.outerHTML = this.storageLine();
  }

  private storageLine(): string {
    if (this.storagePersistent === null) return '<p class="storage"></p>';
    return this.storagePersistent
      ? '<p class="storage ok-note">Browser storage is persistent: the browser won\'t clear stored sessions to free disk space.</p>'
      : '<p class="storage warn-note">Browser storage is not persistent: if the disk runs low, the browser may clear sessions that haven\'t been downloaded. Download each session at the end.</p>';
  }

  show(config: ExperimentConfig, note = ''): void {
    this.draft = structuredClone(config) as unknown as Record<string, unknown>;
    this.render(note);
  }

  private render(note: string): void {
    const parsed = ExperimentConfigSchema.safeParse(this.draft);
    const errors = new Map<string, string>();
    if (!parsed.success) for (const issue of parsed.error.issues) errors.set(issue.path.join('.'), issue.message);
    const cfg = (parsed.success ? parsed.data : this.draft) as ExperimentConfig;

    const field = (f: Field) => {
      if (f.when && parsed.success && !f.when(cfg)) return '';
      const v = get(this.draft, f.path);
      const id = `f-${f.path}`;
      let input: string;
      if (f.kind === 'bool') {
        input = `<input type="checkbox" id="${id}" data-path="${f.path}"${v ? ' checked' : ''} />`;
      } else if (typeof f.kind === 'object') {
        input = `<select id="${id}" data-path="${f.path}">${f.kind.options
          .map(([value, label]) => `<option value="${value}"${value === v ? ' selected' : ''}>${label}</option>`)
          .join('')}</select>`;
      } else {
        const type = f.kind === 'text' ? 'text' : 'number';
        const step = f.step ?? (f.kind === 'number' ? 'any' : 1);
        input = `<input type="${type}" id="${id}" data-path="${f.path}" step="${step}" value="${v === undefined ? '' : escapeAttr(String(v))}" />`;
      }
      const err = errors.get(f.path);
      const hint = !err && parsed.success && f.hint ? f.hint(cfg) : '';
      return `<label class="field${err ? ' invalid' : ''}" for="${id}"><span>${f.label}</span>${input}${
        err ? `<em class="err">${escapeHtml(err)}</em>` : hint ? `<em>${escapeHtml(hint)}</em>` : ''
      }</label>`;
    };

    const focused = (document.activeElement as HTMLElement | null)?.dataset?.path;
    this.el.innerHTML = `
      <div class="window setup">
        <div class="title">GT Ball Drop: session setup</div>
        <div class="body">
          <p class="intro">Browser mode. Set up the session, then hand over to the participant. Data stays on this
          computer and is offered as a download at the end.</p>
          ${this.storageLine()}
          <div class="toolbar">
            <label>Start from <select data-act="preset"><option value="">choose a preset…</option>${PRESETS.map(
              (p) => `<option value="${p.id}">${escapeHtml(p.label)}</option>`,
            ).join('')}</select></label>
            <button type="button" data-act="defaults">Reset to defaults</button>
            <button type="button" data-act="load">Load config.json…</button>
            <button type="button" data-act="save">Save config.json</button>
            <input type="file" accept=".json,application/json" hidden />
          </div>
          ${note ? `<p class="note">${escapeHtml(note)}</p>` : ''}
          <div class="sections">${SECTIONS.map(
            (s) => `<fieldset><legend>${s.title}</legend>${s.fields.map(field).join('')}</fieldset>`,
          ).join('')}</div>
          <div class="buttons"><button type="button" data-act="continue"${parsed.success ? '' : ' disabled'}>Continue to participant screen</button></div>
        </div>
      </div>`;
    this.el.hidden = false;

    for (const input of this.el.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-path]')) {
      input.addEventListener(input.type === 'checkbox' || input.tagName === 'SELECT' ? 'change' : 'input', () => this.onField(input));
      if (input.dataset.path === focused) input.focus();
    }
    const q = <T extends HTMLElement>(sel: string) => this.el.querySelector<T>(sel)!;
    q<HTMLSelectElement>('[data-act="preset"]').addEventListener('change', (ev) => {
      const p = PRESETS.find((x) => x.id === (ev.target as HTMLSelectElement).value);
      if (!p) return;
      // Presets carry no look of their own: keep the one on screen.
      const look = ExperimentConfigSchema.shape.appearance.safeParse(this.draft.appearance);
      this.replace({ ...p.config, appearance: look.success ? look.data : p.config.appearance }, `Settings from the preset "${p.label}". The look is unchanged.`);
    });
    q('[data-act="defaults"]').addEventListener('click', () => this.replace(forBrowserMode(DEFAULT_CONFIG), 'Default settings.'));
    const file = q<HTMLInputElement>('input[type="file"]');
    q('[data-act="load"]').addEventListener('click', () => file.click());
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (!f) return;
      try {
        const loaded = resolveConfig(JSON.parse(await f.text()));
        this.replace(loaded, `Loaded ${f.name}.`);
      } catch (err) {
        this.render(`${f.name} is not a valid config: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`);
      }
    });
    // Validate again on click: typing updates the draft without re-rendering this closure.
    q('[data-act="save"]').addEventListener('click', () => {
      const parsed = ExperimentConfigSchema.safeParse(this.draft);
      if (!parsed.success) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(forBrowserMode(parsed.data), null, 2) + '\n'], { type: 'application/json' }));
      a.download = 'config.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    q('[data-act="continue"]').addEventListener('click', () => {
      const parsed = ExperimentConfigSchema.safeParse(this.draft);
      if (parsed.success) this.handlers.onContinue(forBrowserMode(parsed.data));
    });
  }

  private replace(config: ExperimentConfig, note: string): void {
    this.draft = structuredClone(config) as unknown as Record<string, unknown>;
    this.render(note);
    this.handlers.onAppearance(config.appearance);
  }

  private onField(input: HTMLInputElement | HTMLSelectElement): void {
    const path = input.dataset.path!;
    const fieldDef = SECTIONS.flatMap((s) => s.fields).find((f) => f.path === path)!;
    let value: unknown;
    if (fieldDef.kind === 'bool') value = (input as HTMLInputElement).checked;
    else if (typeof fieldDef.kind === 'object' || fieldDef.kind === 'text') value = input.value;
    else if (fieldDef.kind === 'optional-int') value = input.value.trim() === '' ? undefined : Number(input.value);
    else value = input.value.trim() === '' ? Number.NaN : Number(input.value);
    set(this.draft, path, value);
    // Re-render for text edits only when the validity or visibility could change, to keep typing smooth.
    const structural = fieldDef.kind === 'bool' || typeof fieldDef.kind === 'object';
    if (structural) this.render('');
    else this.refreshValidity();
    if (path.startsWith('appearance.')) this.scheduleAppearance();
  }

  /** Update error messages, hints and the Continue button without rebuilding the form. */
  private refreshValidity(): void {
    const parsed = ExperimentConfigSchema.safeParse(this.draft);
    const errors = new Map<string, string>();
    if (!parsed.success) for (const issue of parsed.error.issues) errors.set(issue.path.join('.'), issue.message);
    for (const label of this.el.querySelectorAll<HTMLLabelElement>('label.field')) {
      const input = label.querySelector<HTMLElement>('[data-path]');
      const path = input?.dataset.path;
      if (!path) continue;
      const def = SECTIONS.flatMap((s) => s.fields).find((f) => f.path === path)!;
      const err = errors.get(path);
      label.classList.toggle('invalid', !!err);
      let em = label.querySelector('em');
      const text = err ?? (parsed.success && def.hint ? def.hint(parsed.data) : '');
      if (!em && text) em = label.appendChild(document.createElement('em'));
      if (em) {
        em.textContent = text;
        em.className = err ? 'err' : '';
      }
    }
    const cont = this.el.querySelector<HTMLButtonElement>('[data-act="continue"]');
    if (cont) cont.disabled = !parsed.success;
  }

  private scheduleAppearance(): void {
    if (this.appearanceTimer) clearTimeout(this.appearanceTimer);
    this.appearanceTimer = setTimeout(() => {
      const parsed = ExperimentConfigSchema.safeParse(this.draft);
      if (parsed.success) this.handlers.onAppearance(parsed.data.appearance);
    }, 300);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
const escapeAttr = escapeHtml;
