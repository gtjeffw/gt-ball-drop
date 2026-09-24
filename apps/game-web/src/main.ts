import { Experiment, GEOMETRY, laneX, randomSeed, SessionRecorder } from '@gtbd/core';
import { DEFAULT_CONFIG, GTBALLDROP_VERSION, type DomainEvent, type EventEnvelope, type HostToGame } from '@gtbd/protocol';
import { demoCapture, hostCapture, type Capture } from './capture';
import { DEMO_PRESETS, demoPreset } from './demo';
import { Renderer } from './renderer';
import { Screens } from './screens';

/** The static-website build (npm run build:demo): no host, nothing leaves the browser. */
const DEMO = import.meta.env.VITE_DEMO === '1';

const params = new URLSearchParams(location.search);
const stage = document.getElementById('stage')!;
const canvas = document.getElementById('view') as HTMLCanvasElement;
const hud = document.getElementById('hud')!;
hud.textContent = `GT Ball Drop v. ${GTBALLDROP_VERSION}`;

// ---- data capture -------------------------------------------------------------------------

const adminLinks = new Set<string>();
const capture: Capture = DEMO ? demoCapture() : await hostCapture((m) => onHostMessage(m));
const preset = DEMO ? demoPreset(params) : null;
const config = preset?.config ?? capture.hello?.config ?? DEFAULT_CONFIG;

// For side-by-side comparison, ?world=classic|clean and ?shading=0..1 override the config.
// (A session's config.json records the config values, not these overrides.)
const worldParam = params.get('world');
const shadingParam = Number(params.get('shading'));
const renderer = new Renderer(canvas, {
  ...config.appearance,
  ...(worldParam === 'classic' || worldParam === 'clean' ? { world: worldParam } : {}),
  ...(params.has('shading') && shadingParam >= 0 && shadingParam <= 1 ? { modelShading: shadingParam } : {}),
});
function layout(): void {
  // Letterbox to the original 4:3.
  const w = Math.min(window.innerWidth, window.innerHeight * GEOMETRY.displayAspect);
  const h = w / GEOMETRY.displayAspect;
  stage.style.width = `${w}px`;
  stage.style.height = `${h}px`;
  renderer.resize(w, h);
}
window.addEventListener('resize', layout);
layout();

let exp: Experiment | null = null;
let pending: EventEnvelope[] = [];
let lastAdvance = performance.now();
let quitting = false;
const results: Extract<DomainEvent, { type: 'block-ended' | 'calibration-ended' }>[] = [];

const flush = () => {
  if (pending.length) capture.record(pending.splice(0));
};
setInterval(flush, 100);

// Status for the admin display and the control API: small, local, and 4 Hz is plenty.
setInterval(() => {
  if (exp) capture.status(exp.status());
}, 250);

function onHostMessage(m: HostToGame): void {
  switch (m.t) {
    case 'hello':
      screens.updateStart({ mode: 'host', pairingCode: m.pairingCode });
      break;
    case 'cmd':
      exp?.dispatch({ type: 'remote', command: m.command, source: m.source });
      break;
    case 'admin-link':
      if (m.status === 'connected') adminLinks.add(m.peerId);
      else adminLinks.delete(m.peerId);
      exp?.dispatch({ type: 'admin-link', status: m.status, peerId: m.peerId });
      screens.updateStart({ adminLinks: [...adminLinks] });
      break;
    case 'clock-sync':
      exp?.dispatch({ type: 'clock-sync', peerId: m.peerId, offsetMs: m.offsetMs, rttMs: m.rttMs });
      break;
    case 'pairing':
      screens.updateStart({ pairingCode: m.code });
      break;
    case 'error':
      console.error('host:', m.message);
      break;
  }
}

// ---- screens and input --------------------------------------------------------------------

const screens = new Screens(document.getElementById('overlay')!, {
  onStart: (pid) => startSession(pid),
  onContinue: () => exp?.dispatch({ type: 'continue', source: 'participant' }),
  onQuit: () => requestQuit(),
  onNewPairingCode: () => capture.newPairingCode(),
  // Demo settings apply on reload, since the renderer is built for one look.
  onDemoOption: (key, value) => {
    const next = new URLSearchParams(location.search);
    next.set(key, value);
    location.search = next.toString();
  },
});

screens.showStart({
  defaultParticipantId: config.defaultParticipantId,
  mode: DEMO ? 'demo' : capture.hello ? 'host' : 'standalone',
  pairingCode: capture.hello?.pairingCode ?? null,
  adminLinks: [],
  remoteControlled: config.remoteControl.enabled,
  demo: preset
    ? { preset: preset.id, presets: DEMO_PRESETS.map(({ id, label }) => ({ id, label })), world: params.get('world') ?? config.appearance.world }
    : undefined,
});

function startSession(participantId: string): void {
  if (exp) return;
  const sessionId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  capture.openSession({ sessionId, participantId, version: GTBALLDROP_VERSION, startedAt, config });
  const recorder = new SessionRecorder(sessionId, () => Math.round(performance.timeOrigin + performance.now()));
  exp = new Experiment({ config, participantId, seed: config.seed ?? randomSeed(), version: GTBALLDROP_VERSION, sessionId });
  exp.on((e) => {
    pending.push(recorder.record(e));
    renderer.handleEvent(e);
    if (e.type === 'block-ended' || e.type === 'calibration-ended') results.push(e);
  });
  screens.hide();
  if (!params.has('nofullscreen') && !document.fullscreenElement) void document.documentElement.requestFullscreen?.().catch(() => {});
  lastAdvance = performance.now();
  exp.start();
  for (const peerId of adminLinks) exp.dispatch({ type: 'admin-link', status: 'connected', peerId });
}

/** Advance the experiment to real time `t` (performance.now() timebase). */
function advanceTo(t: number): void {
  if (!exp) {
    lastAdvance = t;
    return;
  }
  const dt = t - lastAdvance;
  if (dt > 0) {
    exp.advance(dt);
    lastAdvance = t;
  }
}

window.addEventListener(
  'keydown',
  (ev) => {
    if (screens.isStart) {
      if (ev.key === 'Escape') void quitApp();
      return;
    }
    if (!exp) return;
    // Bring the experiment up to the moment of the key press first, so a move lands on
    // its own millisecond, not the next frame's.
    advanceTo(ev.timeStamp);
    const screen = exp.status().screen;
    let handled = true;
    switch (ev.code) {
      case 'ArrowLeft':
      case 'KeyA':
        if (!ev.repeat) exp.dispatch({ type: 'move', direction: 'left' });
        break;
      case 'ArrowRight':
      case 'KeyD':
        if (!ev.repeat) exp.dispatch({ type: 'move', direction: 'right' });
        break;
      case 'Enter':
      case 'NumpadEnter':
        exp.dispatch({ type: 'continue', source: 'participant' });
        break;
      case 'Escape':
        if (screen && (screen.interactive || screen.id === 'complete')) requestQuit();
        break;
      case 'Digit9':
      case 'Numpad9':
        // Hidden experimenter keys on non-interactive screens, as in the original.
        if (screen && !screen.interactive) exp.dispatch({ type: 'continue', source: 'experimenter' });
        break;
      case 'Digit0':
      case 'Numpad0':
        if (screen && !screen.interactive) requestQuit();
        break;
      default:
        handled = false;
    }
    if (handled) ev.preventDefault();
  },
  { capture: true },
);

/** Quit button, Escape, or the hidden 0 key: abort a running session (logged), then save and quit. */
function requestQuit(): void {
  if (exp && exp.status().phase !== 'ended') exp.dispatch({ type: 'quit-key' });
  else void quitApp();
}

async function quitApp(): Promise<void> {
  if (quitting) return;
  quitting = true;
  flush();
  screens.showMessage('GTBallDrop', 'Saving session data...');
  const r = await capture.finish();
  screens.showFinished({ message: r.message, downloads: r.downloads, resultsHtml: DEMO ? resultsTable() : undefined, playAgain: DEMO });
}

/** Demo only: a small per-block score table (the lab version shows participants no scores). */
function resultsTable(): string {
  if (!results.length) return '';
  const rows = results.map((e) =>
    e.type === 'calibration-ended'
      ? `<tr><td>Calibration result</td><td colspan="3">speed ${e.ballSpeed.toPrecision(3)}, a ball every ${e.spawnTimeMs} ms</td></tr>`
      : `<tr><td>Block ${e.block + 1}</td><td>${e.caught}</td><td>${e.missed}</td><td>${Math.round((100 * e.caught) / Math.max(1, e.caught + e.missed))}%</td></tr>`,
  );
  return `<table class="results"><tr><th></th><th>Caught</th><th>Missed</th><th>Rate</th></tr>${rows.join('')}</table>`;
}

// ---- main loop ----------------------------------------------------------------------------

function syncScreens(): void {
  // No mouse cursor during play: C4 only drew it while a window was open.
  document.body.classList.toggle('playing', !!exp && !quitting && exp.status().phase === 'running' && !exp.status().screen);
  if (!exp || quitting) return;
  const st = exp.status();
  // Ended: aborted with the quit key (no screen), or, in the demo, finished (skip the
  // "notify the administrator" screen and go straight to the results).
  if (st.phase === 'ended' && (!st.screen || DEMO)) {
    void quitApp();
    return;
  }
  if (st.screen) screens.showPause(st.screen.id, st.screen.interactive);
  else screens.hide();
}

const idle = { catcherX: laneX(GEOMETRY.middleLane), balls: [], tSys: 0 };
function frame(now: number): void {
  advanceTo(now);
  syncScreens();
  renderer.render(exp ? exp.snapshot() : { ...idle, tSys: now });
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
// rAF can be throttled when the window is covered, so a timer keeps experiment time
// honest as well.
setInterval(() => advanceTo(performance.now()), 20);
