import { describe, expect, it } from 'vitest';
import { resolveConfig, type DeepPartial, type DomainEvent, type ExperimentConfig } from '@gtbd/protocol';
import { Experiment, GEOMETRY, laneX, legacyHeader, legacyLines, legacyTokens } from '../src';

function make(partial: DeepPartial<ExperimentConfig>, seed = 1234) {
  const exp = new Experiment({ config: resolveConfig(partial), participantId: 'P001', seed, version: 'test' });
  const events: DomainEvent[] = [];
  exp.on((e) => events.push(e));
  return { exp, events };
}

type Bot = (exp: Experiment) => void;

/** A bot that always goes for the lowest uncaught ball, moving once the catcher has settled. */
const perfectBot: Bot = (exp) => {
  const s = exp.snapshot();
  const target = s.balls.filter((b) => b.burnedAt === null).sort((a, b) => a.z - b.z)[0];
  if (!target) return;
  const lane = Math.round((target.x - GEOMETRY.firstLaneX) / GEOMETRY.laneSpacing);
  if (lane === s.catcherLane || Math.abs(s.catcherX - laneX(s.catcherLane)) > 0.05) return;
  exp.dispatch({ type: 'move', direction: lane < s.catcherLane ? 'left' : 'right' });
};
const idleBot: Bot = () => {};

/** Step 1 ms at a time. A participant press dismisses interactive screens. */
function run(exp: Experiment, bot: Bot, maxMs: number, opts: { pressContinue?: boolean } = {}) {
  const pressContinue = opts.pressContinue ?? true;
  for (let t = 0; t < maxMs; t++) {
    const st = exp.status();
    if (st.phase === 'ended') return t;
    if (st.phase === 'paused' && pressContinue && st.screen?.interactive) exp.dispatch({ type: 'continue', source: 'participant' });
    if (st.phase === 'running') bot(exp);
    exp.advance(1);
  }
  return maxMs;
}

const tokens = (events: DomainEvent[]) => events.flatMap(legacyTokens);
const ofType = <T extends DomainEvent['type']>(events: DomainEvent[], type: T) =>
  events.filter((e): e is Extract<DomainEvent, { type: T }> => e.type === type);

describe('Experiment: blocks without calibration', () => {
  const cfg = { calibration: { enabled: false }, numBlocks: 2, numTrials: 3 };

  it('a perfect player catches everything; legacy log matches the original sequence', () => {
    const { exp, events } = make(cfg);
    exp.start();
    run(exp, perfectBot, 60_000);
    expect(exp.status().phase).toBe('ended');

    const tk = tokens(events).filter((t) => !t.startsWith('BALL_CATCHER'));
    expect(tk).toEqual([
      'GTBALLDROP_VERSION,test',
      'EXPERIMENT_BEGIN',
      'PARTICIPANT_ID,P001',
      'BEGIN_BLOCK,0',
      'BALL_CAUGHT,1',
      'BALL_CAUGHT,2',
      'BALL_CAUGHT,3',
      'END_BLOCK,0',
      'BLOCK_RESULTS_DESCRIPT,BLOCK_NUM,NUM_MISSED,NUM_CAUGHT,NUM_DROPPED',
      'BLOCK_RESULTS,0,0,3,3',
      'BEGIN_BLOCK,1',
      'BALL_CAUGHT,1',
      'BALL_CAUGHT,2',
      'BALL_CAUGHT,3',
      'END_BLOCK,1',
      'BLOCK_RESULTS_DESCRIPT,BLOCK_NUM,NUM_MISSED,NUM_CAUGHT,NUM_DROPPED',
      'BLOCK_RESULTS,1,0,3,3',
      'EXPERIMENT_END',
    ]);
    // The first-block intro and the between-block break both appear.
    expect(ofType(events, 'screen-shown').map((e) => e.screen)).toEqual(['block-intro', 'block-break', 'complete']);
  });

  it('an idle player catches only balls that land in the middle lane', () => {
    const { exp, events } = make({ ...cfg, numBlocks: 1, numTrials: 20 });
    exp.start();
    run(exp, idleBot, 120_000);
    const spawned = ofType(events, 'ball-spawned');
    const caught = ofType(events, 'ball-caught');
    const missed = ofType(events, 'ball-missed');
    expect(spawned).toHaveLength(20);
    expect(caught.length + missed.length).toBe(20);
    expect(caught.every((e) => e.lane === GEOMETRY.middleLane)).toBe(true);
    expect(missed.every((e) => e.lane !== GEOMETRY.middleLane)).toBe(true);
    expect(caught.length).toBe(spawned.filter((e) => e.lane === GEOMETRY.middleLane).length);
  });

  it('balls take (dropZ - catchZMax) / speed ms to reach the catcher', () => {
    const { exp, events } = make({ ...cfg, numBlocks: 1, numTrials: 1, ballSpeed: 0.001, dropMode: 'lane', laneChangeStayChance: 100 });
    exp.start();
    run(exp, idleBot, 30_000);
    const spawn = ofType(events, 'ball-spawned')[0]!;
    const catchEv = ofType(events, 'ball-caught')[0]!;
    const expected = (GEOMETRY.dropZ - GEOMETRY.catchZMax) / 0.001;
    expect(catchEv.tExp - spawn.tExp).toBeGreaterThanOrEqual(Math.floor(expected));
    expect(catchEv.tExp - spawn.tExp).toBeLessThanOrEqual(Math.ceil(expected) + 1);
  });

  it('experiment time stops while a screen is up; system time keeps going', () => {
    const { exp } = make(cfg);
    exp.start();
    expect(exp.status().screen?.id).toBe('block-intro');
    exp.advance(5000);
    expect(exp.status().tExp).toBe(0);
    expect(exp.status().tSys).toBe(5000);
  });

  it('logs catcher moves with the original column numbering (+3 = far left), none at the edge', () => {
    const { exp, events } = make(cfg);
    exp.start();
    exp.dispatch({ type: 'continue', source: 'participant' });
    for (let i = 0; i < 4; i++) exp.dispatch({ type: 'move', direction: 'left' });
    exp.dispatch({ type: 'move', direction: 'right' });
    expect(tokens(events).filter((t) => t.startsWith('BALL_CATCHER'))).toEqual([
      'BALL_CATCHER_LEFT,1',
      'BALL_CATCHER_LEFT,2',
      'BALL_CATCHER_LEFT,3',
      'BALL_CATCHER_RIGHT,2',
    ]);
    expect(ofType(events, 'catcher-moved')).toHaveLength(5); // the attempt at the edge is still recorded
  });

  it('is deterministic for a given seed', () => {
    const go = (seed: number) => {
      const { exp, events } = make({ ...cfg, numTrials: 10 }, seed);
      exp.start();
      run(exp, idleBot, 60_000);
      return JSON.stringify(events);
    };
    expect(go(99)).toBe(go(99));
    expect(go(99)).not.toBe(go(100));
  });

  it('the quit key aborts', () => {
    const { exp, events } = make(cfg);
    exp.start();
    exp.dispatch({ type: 'quit-key' });
    expect(exp.status().phase).toBe('ended');
    expect(exp.status().screen).toBeNull();
    expect(events.at(-1)?.type).toBe('experiment-aborted');
  });
});

describe('Experiment: calibration', () => {
  // The starting difficulty these tests expect, independent of the defaults.
  const base = { ballSpeed: 0.001, ballSpawnTimeMs: 750, laneChangeStayChance: 50 };

  it('runs practice then scored blocks, auto-continues breaks after 2 s of paused time, and gets harder for a perfect player', () => {
    const { exp, events } = make({ ...base, numBlocks: 1, numTrials: 3, calibration: { enabled: true, numTrials: 4 } });
    exp.start();
    expect(exp.status().screen?.id).toBe('calibration-intro');
    run(exp, perfectBot, 120_000);

    const starts = ofType(events, 'calibration-block-started');
    expect(starts[0]).toMatchObject({ calibBlock: -1, ballSpeed: 0.001, spawnTimeMs: 750 });
    expect(starts[1]).toMatchObject({ calibBlock: 0, ballSpeed: 0.001, spawnTimeMs: 750 }); // practice changes nothing
    expect(starts[2]).toMatchObject({ calibBlock: 1, spawnTimeMs: 550 });
    expect(starts[2]!.ballSpeed).toBeCloseTo(0.004, 12);

    // Break screens are dismissed automatically, 2000 ms of system time after they appear.
    const shown = ofType(events, 'screen-shown').filter((e) => e.screen === 'calibration-break');
    const dismissed = ofType(events, 'screen-dismissed').filter((e) => e.screen === 'calibration-break');
    expect(shown.length).toBeGreaterThan(1);
    for (let i = 0; i < dismissed.length; i++) {
      expect(dismissed[i]!.by).toBe('auto');
      expect(dismissed[i]!.tSys - shown[i]!.tSys).toBe(2000);
      expect(dismissed[i]!.tExp).toBe(shown[i]!.tExp);
    }
  });

  it('legacy calibration lines match the original format', () => {
    const { exp, events } = make({ ...base, numBlocks: 1, numTrials: 3, calibration: { enabled: true, numTrials: 2 } });
    exp.start();
    run(exp, perfectBot, 20_000);
    const tk = tokens(events);
    expect(tk.slice(0, 7)).toEqual([
      'GTBALLDROP_VERSION,test',
      'EXPERIMENT_BEGIN',
      'PARTICIPANT_ID,P001',
      'BEGIN_CALIB',
      'BEGIN_CALIB_BLOCK,-1',
      'CALIB_CONFIG_DESCRIPT,BALL_SPEED,BALL_SPAWN_TIME_MS,LANE_STAY_CHANCE',
      'CALIB_CONFIG,0.001,750,50',
    ]);
    expect(tk).toContain('CALIB_BLOCK_RESULTS_DESCRIPT,BLOCK_NUM,NUM_MISSED,NUM_CAUGHT,NUM_DROPPED,ADJUST_DIR,FLIP_COUNT');
    expect(tk).toContain('CALIB_BLOCK_RESULTS,-1,0,2,2,1,0');
  });

  it('after calibration: completion screen, then the experiment intro, then block 0 at the calibrated difficulty', () => {
    // An idle player with every ball in the middle lane catches 100%, which is inside a
    // 0.9-1.0 target band, so the first scored block hits the target.
    const { exp, events } = make({
      ...base,
      numBlocks: 1,
      numTrials: 2,
      laneChangeStayChance: 100,
      calibration: { enabled: true, numTrials: 2, targetAvg: 0.95, targetAvgErr: 0.05 },
    });
    exp.start();
    run(exp, idleBot, 200_000);
    const screens = ofType(events, 'screen-shown').map((e) => e.screen);
    expect(screens.slice(0, 1)).toEqual(['calibration-intro']);
    const iComplete = screens.indexOf('calibration-complete');
    expect(iComplete).toBeGreaterThan(0);
    expect(screens[iComplete + 1]).toBe('block-intro');
    const ended = ofType(events, 'calibration-ended')[0]!;
    const spawnsAfter = ofType(events, 'ball-spawned').filter((e) => e.tExp > ended.tExp);
    expect(spawnsAfter.length).toBeGreaterThan(0);
    for (const s of spawnsAfter) expect(s.speed).toBe(ended.ballSpeed);
    expect(tokens(events)).toContain('END_CALIB');
    expect(exp.status().phase).toBe('ended');
  });
});

describe('Experiment: remote control', () => {
  const cfg = { calibration: { enabled: false }, numBlocks: 3, numTrials: 3, remoteControl: { enabled: true } };

  it('break screens ignore the participant and wait for the admin', () => {
    const { exp, events } = make(cfg);
    exp.start();
    expect(exp.status().screen).toEqual({ id: 'block-intro', interactive: false });
    exp.dispatch({ type: 'continue', source: 'participant' });
    expect(exp.status().phase).toBe('paused');
    exp.dispatch({ type: 'remote', command: 'block-start', source: 'test' });
    expect(exp.status().phase).toBe('running');
    expect(ofType(events, 'screen-dismissed')[0]!.by).toBe('admin');
  });

  it('the hidden experimenter key (9) still continues a non-interactive screen', () => {
    const { exp } = make(cfg);
    exp.start();
    exp.dispatch({ type: 'continue', source: 'experimenter' });
    expect(exp.status().phase).toBe('running');
  });

  it('block-end ends the running block (forced); ignored while paused', () => {
    const { exp, events } = make({ ...cfg, remoteControl: { enabled: true, infiniteTrials: true } });
    exp.start();
    exp.dispatch({ type: 'remote', command: 'block-end', source: 'test' });
    expect(ofType(events, 'remote-command').at(-1)).toMatchObject({ command: 'block-end', accepted: false });
    exp.dispatch({ type: 'remote', command: 'block-start', source: 'test' });
    run(exp, perfectBot, 5_000, { pressContinue: false });
    expect(ofType(events, 'block-ended')).toHaveLength(0); // infinite trials: only the admin ends blocks
    exp.dispatch({ type: 'remote', command: 'block-end', source: 'test' });
    exp.advance(1);
    expect(ofType(events, 'block-ended')[0]).toMatchObject({ block: 0, forcedByAdmin: true });
    expect(exp.status().screen?.id).toBe('block-break');
  });

  it('quit ends the block and the experiment', () => {
    const { exp } = make(cfg);
    exp.start();
    exp.dispatch({ type: 'remote', command: 'block-start', source: 'test' });
    exp.advance(1000);
    exp.dispatch({ type: 'remote', command: 'quit', source: 'test' });
    exp.advance(1);
    expect(exp.status().phase).toBe('ended');
    expect(exp.status().screen?.id).toBe('complete');
  });

  it('remote commands are rejected when remote control is off', () => {
    const { exp, events } = make({ calibration: { enabled: false } });
    exp.start();
    exp.dispatch({ type: 'remote', command: 'block-start', source: 'test' });
    expect(exp.status().phase).toBe('paused');
    expect(ofType(events, 'remote-command')[0]!.accepted).toBe(false);
  });
});

describe('legacy log format', () => {
  it('formats timestamped CRLF lines from experiment time', () => {
    const line = legacyLines({ type: 'ball-caught', ballId: 1, lane: 3, catcherX: 0, count: 2, tExp: 12345, tSys: 20000 });
    expect(line).toBe('12.345,BALL_CAUGHT,2\r\n');
    expect(legacyHeader(new Date(2026, 8, 24, 9, 5, 7))).toBe('0.000,DATE,09/24/2026\r\n0.000,TIME,09:05:07\r\n');
  });
});
