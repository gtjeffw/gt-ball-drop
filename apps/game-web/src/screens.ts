import type { ScreenId } from '@gtbd/protocol';

/** Dialog text, copied from the original Interface.cpp. */
const TEXT: Record<ScreenId, { interactive: string; nonInteractive: string }> = {
  'calibration-intro': {
    interactive: 'Difficulty Calibration will begin. Hit Enter or click Continue to start.',
    nonInteractive: 'Difficulty Calibration will begin shortly. See other screen for signal to start.',
  },
  'calibration-break': {
    interactive: 'Difficulty adjusting. Hit Enter or click Continue for next step.',
    nonInteractive: 'Difficulty adjusting now.',
  },
  'calibration-complete': {
    interactive: 'Difficulty Calibration is complete. Notify experiment administrator to continue.',
    nonInteractive: 'Difficulty Calibration is complete.',
  },
  'block-intro': {
    interactive: 'Experiment now begins. Hit Enter or click Continue to begin.',
    nonInteractive: 'Experiment will begin shortly. See other screen for signal to start.',
  },
  'block-break': {
    interactive: 'Block complete. Hit Enter or click Continue for next block.',
    nonInteractive: 'Block complete. See other screen for signal to start next block.',
  },
  complete: {
    interactive: 'Experiment complete!  Notify experiment administrator.',
    nonInteractive: 'Experiment complete!  Notify experiment administrator.',
  },
};

export interface StartScreenInfo {
  defaultParticipantId: string;
  /** host: logging to the local host. standalone: host expected but unreachable. demo: static website. */
  mode: 'host' | 'standalone' | 'demo';
  pairingCode: string | null;
  adminLinks: string[];
  remoteControlled: boolean;
  /** Demo only: the settings a visitor can pick. */
  demo?: { preset: string; presets: { id: string; label: string }[]; world: string };
}

export interface Download {
  name: string;
  label: string;
  blob: Blob;
}

/** DOM dialogs over the 3D view, in the style of the C4 GameWindow. */
export class Screens {
  private readonly el: HTMLElement;
  private current: string | null = null;
  private startInfo: StartScreenInfo | null = null;

  constructor(
    root: HTMLElement,
    private readonly handlers: {
      onStart(participantId: string): void;
      onContinue(): void;
      onQuit(): void;
      onNewPairingCode(): void;
      onDemoOption?(key: 'preset' | 'world', value: string): void;
    },
  ) {
    this.el = root;
  }

  showStart(info: StartScreenInfo): void {
    this.startInfo = info;
    this.current = 'start';
    const hostLine =
      info.mode === 'host'
        ? `<span class="ok">Local host connected</span>. Logs are written to disk.`
        : info.mode === 'demo'
          ? `<b>Demo.</b> Runs entirely in this browser and uploads nothing. At the end you can download the session data.`
          : `<span class="warn">No local host</span>. Events are kept in this browser's storage only.`;
    const option = (key: string, value: string, items: { id: string; label: string }[]) =>
      `<select data-opt="${key}">${items.map((o) => `<option value="${o.id}"${o.id === value ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}</select>`;
    const demo = info.demo
      ? `<div class="demo-options">
          <label>Settings ${option('preset', info.demo.preset, info.demo.presets)}</label>
          <label>Look ${option('world', info.demo.world, [
            { id: 'classic', label: 'Classic (cloudy sky)' },
            { id: 'clean', label: 'Clean (pale background)' },
          ])}</label>
        </div>`
      : '';
    const pairing =
      info.mode !== 'host'
        ? ''
        : info.pairingCode
          ? `<div>Admin pairing code: <code class="code">${info.pairingCode}</code> <button class="link" data-act="newcode">new code</button></div>`
          : `<div>Admin already paired. <button class="link" data-act="newcode">Pair another admin</button></div>`;
    const admins = info.adminLinks.length ? `<div class="ok">Admin connected: ${info.adminLinks.join(', ')}</div>` : '';
    this.el.innerHTML = `
      <div class="window">
        <div class="title">GTBallDrop</div>
        <form class="body" data-act="start">
          <label>Participant ID:
            <input id="pid" autocomplete="off" spellcheck="false" maxlength="64" value="${escapeHtml(info.defaultParticipantId)}" />
          </label>
          <div class="buttons">${info.mode === 'demo' ? '' : '<button type="button" data-act="quit">Quit</button>'}<button type="submit">Start</button></div>
          <p class="keys">Catch the balls with <b>←</b> <b>→</b> (or <b>A</b> <b>D</b>).</p>
        </form>
        <details class="experimenter"${info.mode === 'demo' ? ' open' : ''}><summary>${info.mode === 'demo' ? 'About this demo' : 'Experimenter'}</summary>
          <div>${hostLine}</div>${demo}${pairing}${admins}
          ${info.mode === 'demo' ? '' : `<div>Remote control: ${info.remoteControlled ? 'on (breaks wait for the admin panel or control program)' : 'off'}</div>`}
        </details>
      </div>`;
    this.el.hidden = false;
    const input = this.el.querySelector<HTMLInputElement>('#pid')!;
    input.focus();
    input.select();
    this.el.querySelector('form')!.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const pid = input.value.trim();
      if (pid) this.handlers.onStart(pid);
    });
    for (const sel of this.el.querySelectorAll<HTMLSelectElement>('select[data-opt]')) {
      sel.addEventListener('change', () => this.handlers.onDemoOption?.(sel.dataset.opt as 'preset' | 'world', sel.value));
    }
    this.bindButtons();
  }

  /** The end of a session: a message, an optional results table, downloads, and optionally "Play again". */
  showFinished(opts: { message: string; resultsHtml?: string; downloads: Download[]; playAgain: boolean }): void {
    this.current = 'finished';
    const links = opts.downloads
      .map((d, i) => `<button type="button" data-download="${i}">Download ${escapeHtml(d.label)}</button>`)
      .join('');
    this.el.innerHTML = `<div class="window"><div class="title">GTBallDrop</div><div class="body">
        <p>${escapeHtml(opts.message)}</p>${opts.resultsHtml ?? ''}
        ${links ? `<div class="buttons downloads">${links}</div>` : ''}
        ${opts.playAgain ? '<div class="buttons"><button type="button" data-act="again">Play again</button></div>' : ''}
      </div></div>`;
    this.el.hidden = false;
    for (const b of this.el.querySelectorAll<HTMLButtonElement>('button[data-download]')) {
      b.addEventListener('click', () => {
        const d = opts.downloads[Number(b.dataset.download)]!;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(d.blob);
        a.download = d.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      });
    }
    this.el.querySelector('button[data-act="again"]')?.addEventListener('click', () => location.reload());
  }

  updateStart(patch: Partial<StartScreenInfo>): void {
    if (this.current !== 'start' || !this.startInfo) return;
    const pid = this.el.querySelector<HTMLInputElement>('#pid')?.value;
    const open = this.el.querySelector('details')?.open;
    this.showStart({ ...this.startInfo, ...patch, defaultParticipantId: pid ?? this.startInfo.defaultParticipantId });
    const d = this.el.querySelector('details');
    if (d && open) d.open = true;
  }

  showPause(id: ScreenId, interactive: boolean): void {
    const key = `${id}:${interactive}`;
    if (this.current === key) return;
    this.current = key;
    const text = interactive ? TEXT[id].interactive : TEXT[id].nonInteractive;
    // Non-interactive screens have no buttons: the admin panel, a control program or the
    // hidden 9/0 keys move things on.
    const buttons =
      id === 'complete'
        ? `<div class="buttons"><button data-act="quit">Quit</button></div>`
        : interactive
          ? `<div class="buttons"><button data-act="quit">Quit</button><button data-act="continue">Continue</button></div>`
          : '';
    this.el.innerHTML = `<div class="window"><div class="title">GTBallDrop</div><div class="body"><p>${text}</p>${buttons}</div></div>`;
    this.el.hidden = false;
    this.bindButtons();
  }

  showMessage(title: string, text: string): void {
    this.current = `msg:${text}`;
    this.el.innerHTML = `<div class="window"><div class="title">${escapeHtml(title)}</div><div class="body"><p>${escapeHtml(text)}</p></div></div>`;
    this.el.hidden = false;
  }

  hide(): void {
    if (this.current === null) return;
    this.current = null;
    this.el.hidden = true;
    this.el.innerHTML = '';
  }

  get isStart(): boolean {
    return this.current === 'start';
  }

  private bindButtons(): void {
    for (const b of this.el.querySelectorAll<HTMLButtonElement>('button[data-act]')) {
      b.addEventListener('click', () => {
        const act = b.dataset.act;
        if (act === 'continue') this.handlers.onContinue();
        else if (act === 'quit') this.handlers.onQuit();
        else if (act === 'newcode') this.handlers.onNewPairingCode();
      });
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
