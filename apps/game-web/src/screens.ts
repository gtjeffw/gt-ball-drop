import type { ScreenId } from '@gtbd/protocol';
import type { Download, StoredSession } from './capture';

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
  /** host: logging to the local host. standalone: host expected but unreachable. browser: static website, data kept in the browser. */
  mode: 'host' | 'standalone' | 'browser';
  pairingCode: string | null;
  adminLinks: string[];
  remoteControlled: boolean;
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
      /** Browser mode: back from the participant screen to the setup screen. */
      onSettings?(): void;
    },
  ) {
    this.el = root;
  }

  showStart(info: StartScreenInfo): void {
    this.startInfo = info;
    this.current = 'start';
    const browser = info.mode === 'browser';
    const hostLine =
      info.mode === 'host'
        ? `<span class="ok">Local host connected</span>. Logs are written to disk.`
        : browser
          ? `<b>Browser mode.</b> Data stays on this computer and is offered as a download at the end.`
          : `<span class="warn">No local host</span>. Events are kept in this browser's storage only.`;
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
          <div class="buttons">${browser ? '<button type="button" data-act="settings">Settings</button>' : '<button type="button" data-act="quit">Quit</button>'}<button type="submit">Start</button></div>
          <p class="keys">Catch the balls with <b>←</b> <b>→</b> (or <b>A</b> <b>D</b>).</p>
        </form>
        <details class="experimenter"><summary>Experimenter</summary>
          <div>${hostLine}</div>${pairing}${admins}
          ${browser ? '' : `<div>Remote control: ${info.remoteControlled ? 'on (breaks wait for the admin panel or control program)' : 'off'}</div>`}
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
    this.bindButtons();
  }

  /**
   * The end of a session: a message and any downloads. Browser mode adds the block results
   * (collapsed, for the experimenter: the lab version shows participants no scores) and a
   * button to set up the next session.
   */
  showFinished(opts: { message: string; downloads: Download[]; resultsHtml?: string; onDownload?(): void; next?: { label: string; action(): void } }): void {
    this.current = 'finished';
    const links = opts.downloads
      .map((d, i) => `<button type="button" data-download="${i}">Download ${escapeHtml(d.label)}</button>`)
      .join('');
    this.el.innerHTML = `<div class="window"><div class="title">GTBallDrop</div><div class="body">
        <p>${escapeHtml(opts.message)}</p>
        ${links ? `<div class="buttons downloads">${links}</div>` : ''}
        ${opts.resultsHtml ? `<details class="results-box"><summary>Results</summary>${opts.resultsHtml}</details>` : ''}
        ${opts.next ? `<div class="buttons"><button type="button" data-act="next">${escapeHtml(opts.next.label)}</button></div>` : ''}
      </div></div>`;
    this.el.hidden = false;
    for (const b of this.el.querySelectorAll<HTMLButtonElement>('button[data-download]')) {
      b.addEventListener('click', () => {
        saveFile(opts.downloads[Number(b.dataset.download)]!);
        opts.onDownload?.();
      });
    }
    this.el.querySelector('button[data-act="next"]')?.addEventListener('click', () => opts.next?.action());
  }

  /** Browser mode, on load: sessions whose data is still in browser storage. */
  showStored(
    sessions: StoredSession[],
    handlers: { download(s: StoredSession): Promise<void>; discard(s: StoredSession): Promise<void>; done(): void },
  ): void {
    this.current = 'stored';
    const rows = sessions
      .map(
        (s, i) => `<tr data-row="${i}"><td>${escapeHtml(s.participantId)}</td><td>${escapeHtml(s.startedAt.toLocaleString())}</td><td>${s.events}</td>
          <td><button type="button" data-download="${i}">Download</button> <button type="button" data-discard="${i}">Discard</button></td></tr>`,
      )
      .join('');
    this.el.innerHTML = `<div class="window"><div class="title">GTBallDrop</div><div class="body">
        <p>Data from ${sessions.length === 1 ? 'an earlier session is' : 'earlier sessions are'} still in this browser. Download it before discarding it.</p>
        <table class="results stored"><tr><th>Participant</th><th>Started</th><th>Events</th><th></th></tr>${rows}</table>
        <div class="buttons"><button type="button" data-act="done">Continue</button></div>
      </div></div>`;
    this.el.hidden = false;
    for (const b of this.el.querySelectorAll<HTMLButtonElement>('button[data-download]')) {
      b.addEventListener('click', () => void handlers.download(sessions[Number(b.dataset.download)]!));
    }
    for (const b of this.el.querySelectorAll<HTMLButtonElement>('button[data-discard]')) {
      b.addEventListener('click', async () => {
        const s = sessions[Number(b.dataset.discard)]!;
        if (!confirm(`Delete the data of ${s.participantId} (${s.startedAt.toLocaleString()}) from this browser? This cannot be undone.`)) return;
        await handlers.discard(s);
        b.closest('tr')?.remove();
      });
    }
    this.el.querySelector('button[data-act="done"]')!.addEventListener('click', () => handlers.done());
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

  /** Another component (the setup screen) is about to use the overlay. */
  external(name: string): HTMLElement {
    this.current = name;
    this.el.hidden = false;
    return this.el;
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
        else if (act === 'settings') this.handlers.onSettings?.();
      });
    }
  }
}

export function saveFile(d: Download): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(d.blob);
  a.download = d.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
