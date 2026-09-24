import { Experiment, GEOMETRY, laneX, randomSeed, SessionRecorder } from '@gtbd/core';
import { DEFAULT_CONFIG, GTBALLDROP_VERSION, type EventEnvelope } from '@gtbd/protocol';
import { IndexedDbOutboxStore, Replicator } from '@gtbd/sinks';
import { HostLink, hostTarget } from './host-link';
import { Renderer } from './renderer';
import { Screens } from './screens';

const params = new URLSearchParams(location.search);
const stage = document.getElementById('stage')!;
const canvas = document.getElementById('view') as HTMLCanvasElement;
const hud = document.getElementById('hud')!;
hud.textContent = `GT Ball Drop v. ${GTBALLDROP_VERSION}`;

// ---- host link and data capture -----------------------------------------------------------

const link = new HostLink(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ui`);
const hello = await link.start();
const config = hello?.config ?? DEFAULT_CONFIG;
const adminLinks = new Set<string>();

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

// Local-first: every event goes to the browser's IndexedDB outbox, then to the host,
// which fsyncs and acks. A cloud target would be one more entry in this list.
const replicator = new Replicator(new IndexedDbOutboxStore(), [hostTarget(link)]);
replicator.start();

let exp: Experiment | null = null;
let pending: EventEnvelope[] = [];
let lastAdvance = performance.now();
let quitting = false;

const flush = () => {
  if (pending.length) void replicator.append(pending.splice(0));
};
setInterval(flush, 100);

// Status for the admin display: small, local, and 4 Hz is plenty.
setInterval(() => {
  if (exp) link.send({ t: 'status', status: exp.status() });
}, 250);

link.on((m) => {
  switch (m.t) {
    case 'hello':
      screens.updateStart({ hostState: 'connected', pairingCode: m.pairingCode });
      break;
    case 'cmd':
      exp?.dispatch({ type: 'admin', command: m.command });
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
});

// ---- screens and input --------------------------------------------------------------------

const screens = new Screens(document.getElementById('overlay')!, {
  onStart: (pid) => startSession(pid),
  onContinue: () => exp?.dispatch({ type: 'continue', source: 'participant' }),
  onQuit: () => requestQuit(),
  onNewPairingCode: () => link.send({ t: 'pairing.new' }),
});

screens.showStart({
  defaultParticipantId: config.defaultParticipantId,
  hostState: hello ? 'connected' : 'standalone',
  pairingCode: hello?.pairingCode ?? null,
  adminLinks: [],
  adminControlled: config.adminControl.enabled,
});

function startSession(participantId: string): void {
  if (exp) return;
  const sessionId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  link.registerSession({ sessionId, participantId, version: GTBALLDROP_VERSION, startedAt, config });
  const recorder = new SessionRecorder(sessionId, () => Math.round(performance.timeOrigin + performance.now()));
  exp = new Experiment({ config, participantId, seed: config.seed ?? randomSeed(), version: GTBALLDROP_VERSION, sessionId });
  exp.on((e) => {
    pending.push(recorder.record(e));
    renderer.handleEvent(e);
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
  const deadline = performance.now() + 5000;
  while (!(await replicator.drained()) && performance.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  const saved = await replicator.drained();
  link.send({ t: 'app.quit' });
  screens.showMessage(
    'GTBallDrop',
    saved ? 'Session saved. You may close this window.' : 'Could not reach the local host: data is kept in browser storage and will be sent when it is back.',
  );
}

// ---- main loop ----------------------------------------------------------------------------

function syncScreens(): void {
  // No mouse cursor during play: C4 only drew it while a window was open.
  document.body.classList.toggle('playing', !!exp && !quitting && exp.status().phase === 'running' && !exp.status().screen);
  if (!exp || quitting) return;
  const st = exp.status();
  if (st.phase === 'ended' && !st.screen) {
    void quitApp(); // aborted with the quit key
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
