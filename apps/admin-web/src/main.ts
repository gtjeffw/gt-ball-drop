import { legacyTimestamp, legacyTokens } from '@gtbd/core';
import type { AdminHostToUi, AdminUiToHost, ExperimentStatus, MirrorSummary, PeerSummary, ScreenId } from '@gtbd/protocol';

/**
 * The admin panel, replacing the Java/Swing BallDropAdmin. The Java app guessed the game's
 * state by counting its own button presses. This page is driven by the participant's
 * actual status, so it always offers the command that makes sense right now.
 */
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const hostState = $('host-state');
const address = $<HTMLInputElement>('address');
const code = $<HTMLInputElement>('code');
const peerState = $('peer-state');
const statusEl = $('status');
const primary = $<HTMLButtonElement>('primary');
const quit = $<HTMLButtonElement>('quit');
const note = $('control-note');
const mirrorEl = $('mirror');
const feed = $('feed');

const SCREEN_LABEL: Record<ScreenId, string> = {
  'calibration-intro': 'Calibration intro',
  'calibration-break': 'Calibration break (auto-continues)',
  'calibration-complete': 'Calibration complete',
  'block-intro': 'Experiment intro',
  'block-break': 'Between blocks',
  complete: 'Experiment complete',
};

let ws: WebSocket | null = null;
let peer: PeerSummary | null = null;
let status: ExperimentStatus | null = null;
let feedCount = 0;

function send(msg: AdminUiToHost): void {
  ws?.send(JSON.stringify(msg));
}

function connectLocal(): void {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ui`);
  ws.onopen = () => {
    hostState.textContent = 'local host connected';
  };
  ws.onclose = () => {
    hostState.textContent = 'local host offline, retrying...';
    setTimeout(connectLocal, 1000);
  };
  ws.onmessage = (ev) => handle(JSON.parse(String(ev.data)) as AdminHostToUi);
}

function handle(m: AdminHostToUi): void {
  switch (m.t) {
    case 'hello':
      if (!address.value) address.value = m.knownPeers[0] ?? localStorage.getItem('gtbd.admin.address') ?? '127.0.0.1:4280';
      break;
    case 'peer':
      peer = m.peer;
      renderPeer();
      renderControl();
      break;
    case 'status':
      status = m.status;
      renderControl();
      break;
    case 'mirror':
      renderMirror(m.mirror);
      break;
    case 'event': {
      const e = m.envelope.event;
      const tokens = legacyTokens(e);
      const text = tokens.length ? tokens.filter((t) => !t.endsWith('_DESCRIPT') && !t.includes('_DESCRIPT,')).join('  ') : e.type;
      const li = document.createElement('li');
      li.textContent = `${legacyTimestamp(e.tExp)}  ${text}`;
      feed.prepend(li);
      if (++feedCount > 200) feed.lastElementChild?.remove();
      break;
    }
    case 'error':
      note.textContent = m.message;
      break;
  }
}

function renderPeer(): void {
  if (!peer) return;
  const clock = peer.clock ? ` · clock offset ${peer.clock.offsetMs.toFixed(1)} ms (RTT ${peer.clock.rttMs} ms)` : '';
  peerState.innerHTML = `<span class="state ${peer.state}">${peer.state}</span>${peer.peerId ? ` · ${peer.peerId}` : ''}${clock}${
    peer.error ? `<div class="note">${escapeHtml(peer.error)}</div>` : ''
  }`;
}

function renderControl(): void {
  const connected = peer?.state === 'connected';
  const st = connected ? status : null;
  note.textContent = '';
  if (!st || st.phase === 'not-started') {
    statusEl.textContent = connected ? 'Connected. Waiting for the participant to start a session.' : 'No participant connected.';
    primary.textContent = '...';
    primary.disabled = true;
    quit.disabled = true;
    return;
  }
  const block = st.calibrating
    ? `Calibration block ${st.calibBlock < 0 ? 'practice' : st.calibBlock}`
    : `Block ${Math.min(st.block + 1, st.numBlocks)} of ${st.numBlocks >= 9_999_999 ? '∞' : st.numBlocks}`;
  const trials = st.numTrials >= 9_999_999 ? '∞' : st.numTrials;
  statusEl.innerHTML = `
    ${st.screen ? `<div class="screen">Showing: <b>${SCREEN_LABEL[st.screen.id]}</b>${st.screen.interactive ? ' (participant can continue)' : ''}</div>` : ''}
    <dl>
      <dt>Participant</dt><dd>${escapeHtml(st.participantId ?? '?')}</dd>
      <dt>Phase</dt><dd>${st.phase}</dd>
      <dt>Where</dt><dd>${block}</dd>
      <dt>Balls</dt><dd>${st.counts.caught} caught · ${st.counts.missed} missed · ${st.counts.created}/${trials} dropped</dd>
      <dt>Difficulty</dt><dd>speed ${st.difficulty.ballSpeed.toPrecision(3)} u/ms · spawn every ${st.difficulty.spawnTimeMs} ms</dd>
      <dt>Experiment time</dt><dd>${legacyTimestamp(st.tExp)} s</dd>
    </dl>`;

  const onBreak = st.screen !== null && st.screen.id !== 'complete';
  if (onBreak) {
    primary.textContent = st.screen!.id.startsWith('calibration') ? 'Continue' : 'Start block';
    primary.dataset.cmd = 'block-start';
  } else {
    primary.textContent = 'End block';
    primary.dataset.cmd = 'block-end';
  }
  const canCommand = st.adminControlled && st.phase !== 'ended';
  primary.disabled = !canCommand || (!onBreak && st.phase !== 'running');
  quit.disabled = !canCommand;
  if (!st.adminControlled) note.textContent = 'Admin control is off in this session\'s config (adminControl.enabled), so commands are ignored. Monitoring only.';
}

function renderMirror(m: MirrorSummary): void {
  mirrorEl.innerHTML = `Session <code>${m.sessionId}</code> · ${escapeHtml(m.participantId ?? '')} · ${m.lastSeq + 1} events · <code>${escapeHtml(m.dir)}</code>`;
}

$('connect-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const addr = address.value.trim();
  if (!addr) return;
  localStorage.setItem('gtbd.admin.address', addr);
  send({ t: 'connect', address: addr, ...(code.value.trim() ? { pairingCode: code.value.trim() } : {}) });
  code.value = '';
});
$('disconnect').addEventListener('click', () => send({ t: 'disconnect' }));
primary.addEventListener('click', () => {
  const cmd = primary.dataset.cmd as 'block-start' | 'block-end' | undefined;
  if (cmd) send({ t: 'cmd', command: cmd });
});
quit.addEventListener('click', () => {
  if (confirm('End the current block and the experiment?')) send({ t: 'cmd', command: 'quit' });
});

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

connectLocal();
