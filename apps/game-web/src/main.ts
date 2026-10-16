import { Experiment, GEOMETRY, laneX, randomSeed, SessionRecorder } from '@gtbd/core';
import {
  DEFAULT_CONFIG,
  ExperimentConfigSchema,
  GTBALLDROP_VERSION,
  type AppearanceConfig,
  type DomainEvent,
  type EventEnvelope,
  type ExperimentConfig,
  type HostToGame,
} from '@gtbd/protocol';
import { continuousX, PositionMapper, StepMapper } from './axis-mapping';
import { browserCapture, hostCapture, type BrowserCapture, type Capture } from './capture';
import { Controller } from './controller';
import { ControllerPanel } from './controller-panel';
import { preset } from './presets';
import { Renderer } from './renderer';
import { saveFile, Screens } from './screens';
import { forBrowserMode, SetupScreen } from './setup';

/**
 * The static-website build (npm run build:browser), for sessions with the experimenter in
 * the room: a setup screen instead of config.json, and a download instead of a host.
 */
const BROWSER = import.meta.env.VITE_BROWSER === '1';
const REMEMBERED_CONFIG = 'gtbd.browser.config';

const params = new URLSearchParams(location.search);
const stage = document.getElementById('stage')!;
const hud = document.getElementById('hud')!;
hud.textContent = `GT Ball Drop v. ${GTBALLDROP_VERSION}`;

// ---- data capture -------------------------------------------------------------------------

const adminLinks = new Set<string>();
const browserStore: BrowserCapture | null = BROWSER ? browserCapture() : null;
const capture: Capture = browserStore ?? (await hostCapture((m) => onHostMessage(m)));
/** Browser mode: ?preset=<id>, else the settings last used in this browser. */
const urlPreset = BROWSER ? preset(params.get('preset')) : null;
const remembered = BROWSER && !urlPreset ? rememberedConfig() : null;
let config: ExperimentConfig = BROWSER
  ? forBrowserMode(urlPreset ?? remembered ?? DEFAULT_CONFIG)
  : (capture.hello?.config ?? DEFAULT_CONFIG);
/** Shown the first time the setup screen opens. */
let setupNote = remembered ? 'These are the settings last used in this browser. Reset to defaults to start from the lab defaults.' : '';

function rememberedConfig(): ExperimentConfig | null {
  try {
    const parsed = ExperimentConfigSchema.safeParse(JSON.parse(localStorage.getItem(REMEMBERED_CONFIG) ?? 'null'));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// For side-by-side comparison with a host, ?world=classic|clean and ?shading=0..1 override
// the config. (A session's config.json records the config values, not these overrides.)
const worldParam = params.get('world');
const shadingParam = Number(params.get('shading'));
let renderer = new Renderer(document.getElementById('view') as HTMLCanvasElement, {
  ...config.appearance,
  ...(!BROWSER && (worldParam === 'classic' || worldParam === 'clean') ? { world: worldParam } : {}),
  ...(!BROWSER && params.has('shading') && shadingParam >= 0 && shadingParam <= 1 ? { modelShading: shadingParam } : {}),
});
let rendererLook = JSON.stringify(config.appearance);

/** The renderer is built for one look; a new look gets a new renderer on a new canvas. */
function setAppearance(appearance: AppearanceConfig): void {
  if (JSON.stringify(appearance) === rendererLook) return;
  rendererLook = JSON.stringify(appearance);
  const old = document.getElementById('view') as HTMLCanvasElement;
  const fresh = document.createElement('canvas');
  fresh.id = 'view';
  old.replaceWith(fresh);
  renderer.dispose();
  renderer = new Renderer(fresh, appearance);
  layout();
}

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
let sessionId: string | null = null;
const results: Extract<DomainEvent, { type: 'block-ended' | 'calibration-ended' }>[] = [];

const flush = () => {
  if (pending.length) capture.record(pending.splice(0));
};
setInterval(flush, 100);
// When the page is hidden or closed, save what's pending now rather than up to 100 ms later.
addEventListener('pagehide', flush);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flush();
});

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

const controller = new Controller();
const controllerPanel = new ControllerPanel(controller);

const screens = new Screens(document.getElementById('overlay')!, {
  onStart: (pid) => startSession(pid),
  onContinue: () => exp?.dispatch({ type: 'continue', source: 'participant' }),
  onQuit: () => requestQuit(),
  onNewPairingCode: () => capture.newPairingCode(),
  onSettings: () => showSetup(),
  mountController: (el) => controllerPanel.mount(el, () => config.controller, BROWSER ? 'set on the setup screen' : 'set in config.json'),
});

const setup = new SetupScreen(document.getElementById('overlay')!, {
  onAppearance: setAppearance,
  mountController: (el, mapping) => controllerPanel.mount(el, mapping),
  onContinue: (c) => {
    config = c;
    localStorage.setItem(REMEMBERED_CONFIG, JSON.stringify(c));
    setAppearance(c.appearance);
    showStart();
  },
});

function showStart(): void {
  screens.showStart({
    defaultParticipantId: config.defaultParticipantId,
    mode: BROWSER ? 'browser' : capture.hello ? 'host' : 'standalone',
    pairingCode: capture.hello?.pairingCode ?? null,
    adminLinks: [],
    remoteControlled: config.remoteControl.enabled,
    controller: controller.info?.name ?? null,
  });
}

function showSetup(): void {
  screens.external('setup');
  setup.show(config, setupNote);
  setupNote = '';
}

if (browserStore) {
  // Ask the browser not to clear our storage when the disk runs low. It may answer later
  // (Firefox asks the user), so the setup screen updates when it does.
  void browserStore.persistStorage().then((granted) => setup.setStorage(granted));
  // Data a closed or crashed tab didn't get to download.
  const stored = await browserStore.stored();
  if (stored.length)
    screens.showStored(stored, {
      download: async (s) => saveFile(await browserStore.exportSession(s.sessionId)),
      discard: (s) => browserStore.discard(s.sessionId),
      done: showSetup,
    });
  else showSetup();
} else showStart();

function startSession(participantId: string): void {
  if (exp) return;
  sessionId = crypto.randomUUID();
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
  const info = controller.info;
  if (info) exp.dispatch({ type: 'controller', status: 'connected', ...info });
  resetMappers();
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
      if (ev.key === 'Escape') {
        if (BROWSER) showSetup();
        else void quitApp();
      }
      return;
    }
    if (!exp) return;
    // Bring the experiment up to the moment of the key press first, so a move lands on
    // its own millisecond, not the next frame's.
    advanceTo(ev.timeStamp);
    const screen = exp.status().screen;
    // In position mode the paddle follows the controller, so keys would only fight it.
    const keysMove = !ev.repeat && !followsController();
    let handled = true;
    switch (ev.code) {
      case 'ArrowLeft':
      case 'KeyA':
        if (keysMove) exp.dispatch({ type: 'move', direction: 'left', input: 'keyboard' });
        break;
      case 'ArrowRight':
      case 'KeyD':
        if (keysMove) exp.dispatch({ type: 'move', direction: 'right', input: 'keyboard' });
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

// ---- controller -----------------------------------------------------------------------------

/** Axis changes smaller than this (of the −1..1 range) since the last one logged aren't logged. */
const AXIS_LOG_STEP = 0.005;
let stepper = new StepMapper(config.controller);
let positioner = new PositionMapper(GEOMETRY.laneCount, config.controller.positionHysteresis, config.controller.positionReach);
let loggedAxis: number | null = null;

/** A fresh mapping for a new session or device, starting from where the axis is now. */
function resetMappers(): void {
  stepper = new StepMapper(config.controller);
  positioner = new PositionMapper(GEOMETRY.laneCount, config.controller.positionHysteresis, config.controller.positionReach);
  loggedAxis = null;
  const v = controller.value;
  if (v === null) return;
  // A stick already held over when the session starts doesn't count as a push.
  stepper.update(v);
  positioner.update(v);
  logAxis(v, controller.raw!);
}

function followsController(): boolean {
  return config.controller.mapping === 'position' && controller.connected && controller.value !== null;
}


function logAxis(value: number, raw: number): void {
  if (!exp || (loggedAxis !== null && Math.abs(value - loggedAxis) < AXIS_LOG_STEP)) return;
  loggedAxis = value;
  exp.dispatch({ type: 'controller-axis', value: Math.round(value * 10_000) / 10_000, raw });
}

/**
 * Position mode: put the paddle where the controller says (also after a block resets it to
 * the middle). Continuous: straight to the axis's x. Lanes: a lane at a time to its lane.
 */
function followController(): void {
  if (!exp || !followsController()) return;
  const st = exp.status();
  if (st.phase !== 'running') return;
  if (config.controller.positionMotion === 'continuous') {
    exp.dispatch({ type: 'place', x: continuousX(controller.value!, config.controller.positionReach), input: 'controller' });
    return;
  }
  const target = positioner.lane;
  if (target === null) return;
  for (let lane = st.catcherLane; lane !== target; lane += lane < target ? 1 : -1) {
    exp.dispatch({ type: 'move', direction: lane < target ? 'right' : 'left', input: 'controller' });
  }
}

controller.onSample((s) => {
  if (!exp) return;
  // As with keys: bring the experiment up to the moment of the reading first.
  advanceTo(s.t);
  logAxis(s.value, s.raw);
  if (config.controller.mapping === 'step') {
    for (const direction of stepper.update(s.value)) exp.dispatch({ type: 'move', direction, input: 'controller' });
  } else {
    positioner.update(s.value);
    followController();
  }
});

controller.onChange((c) => {
  if (c.kind !== 'connected' && c.kind !== 'disconnected') return;
  screens.updateStart({ controller: controller.info?.name ?? null });
  if (!exp) return;
  advanceTo(performance.now());
  exp.dispatch({ type: 'controller', status: c.kind, ...c.info });
  resetMappers();
});
void controller.init();

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
  if (!browserStore) {
    screens.showFinished({ message: r.message, downloads: r.downloads });
    return;
  }
  // The stored copy is deleted only once the experimenter has downloaded it and moves on;
  // otherwise the next page load offers it again.
  let downloaded = false;
  screens.showFinished({
    message: r.message,
    downloads: r.downloads,
    resultsHtml: resultsTable(),
    onDownload: () => (downloaded = true),
    next: {
      label: 'Set up another session',
      action: async () => {
        if (downloaded && sessionId) await browserStore.discard(sessionId);
        const next = new URLSearchParams(location.search);
        next.delete('preset'); // the settings just used are remembered
        const q = next.toString();
        location.href = location.pathname + (q ? `?${q}` : '');
      },
    },
  });
}

/** Browser mode: a per-block score table for the experimenter. */
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
  // Ended by the quit key (no screen); a finished session waits on the "complete" screen.
  if (st.phase === 'ended' && !st.screen) {
    void quitApp();
    return;
  }
  if (st.screen) screens.showPause(st.screen.id, st.screen.interactive);
  else screens.hide();
}

const idle = { catcherX: laneX(GEOMETRY.middleLane), balls: [], tSys: 0 };
function frame(now: number): void {
  advanceTo(now);
  followController();
  syncScreens();
  renderer.render(exp ? exp.snapshot() : { ...idle, tSys: now });
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
// rAF can be throttled when the window is covered, so a timer keeps experiment time
// honest as well.
setInterval(() => advanceTo(performance.now()), 20);
