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
  hostState: 'connected' | 'standalone';
  pairingCode: string | null;
  adminLinks: string[];
  adminControlled: boolean;
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
    },
  ) {
    this.el = root;
  }

  showStart(info: StartScreenInfo): void {
    this.startInfo = info;
    this.current = 'start';
    const hostLine =
      info.hostState === 'connected'
        ? `<span class="ok">Local host connected</span>. Logs are written to disk.`
        : `<span class="warn">No local host</span>. Events are kept in this browser's storage only.`;
    const pairing =
      info.hostState !== 'connected'
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
          <div class="buttons"><button type="button" data-act="quit">Quit</button><button type="submit">Start</button></div>
        </form>
        <details class="experimenter"><summary>Experimenter</summary>
          <div>${hostLine}</div>${pairing}${admins}
          <div>Admin control: ${info.adminControlled ? 'on (breaks wait for the admin)' : 'off'}</div>
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
    // As in the original, non-interactive screens hide their buttons: the admin (or the
    // hidden 9/0 keys) moves things on.
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
