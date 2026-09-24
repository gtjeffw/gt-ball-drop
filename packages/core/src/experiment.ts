import type {
  AdminCommandName,
  BallView,
  ContinueSource,
  DomainEvent,
  ExperimentConfig,
  ExperimentPhase,
  ExperimentSnapshot,
  ExperimentStatus,
  ScreenId,
} from '@gtbd/protocol';
import { initialStaircase, stepStaircase, type StaircaseState } from './calibration';
import { GEOMETRY, laneX, legacyColumn } from './geometry';
import { nextDropLane } from './lanes';
import { Rng } from './rng';
import { Spring } from './spring';

/** The original's stand-in for "infinite" trials or blocks. */
const INFINITE = 9_999_999;
/** Ball spin: 1°/ms, as in BallController::Move. */
const SPIN_RATE = (2 * Math.PI) / 360;
/** Cap on how much time one advance() call can simulate, so a stalled tab can't lock up the page. */
const MAX_STEPS_PER_ADVANCE = 5_000;

export type ExperimentCommand =
  | { type: 'move'; direction: 'left' | 'right' }
  | { type: 'continue'; source: Exclude<ContinueSource, 'admin' | 'auto'> }
  | { type: 'quit-key' }
  | { type: 'admin'; command: AdminCommandName }
  | { type: 'admin-link'; status: 'connected' | 'lost'; peerId: string }
  | { type: 'clock-sync'; peerId: string; offsetMs: number; rttMs: number };

export interface ExperimentInit {
  config: ExperimentConfig;
  participantId: string;
  seed: number;
  version: string;
  sessionId?: string;
}

interface Ball {
  id: number;
  lane: number;
  x: number;
  z: number;
  speed: number;
  rot: number;
  burnedAt: number | null;
}

type Payload<E> = E extends DomainEvent ? Omit<E, 'tExp' | 'tSys'> : never;

/**
 * The experiment: a port of BallMagister (block/calibration state machine and drop
 * scheduling), DemoController (catcher) and BallController (falling balls).
 *
 * It does no I/O. Drive it by calling advance() with real elapsed time and dispatch() with
 * commands, and subscribe to its DomainEvents. Simulation runs in 1 ms steps, the
 * resolution of the C4 clock.
 */
export class Experiment {
  static readonly STEP_MS = 1;

  private readonly cfg: ExperimentConfig;
  private readonly rng: Rng;
  private readonly listeners = new Set<(e: DomainEvent) => void>();
  private readonly adminControlled: boolean;

  private tExp = 0;
  private tSys = 0;
  private stepRemainder = 0;
  private phase: ExperimentPhase = 'not-started';
  private screen: { id: ScreenId; interactive: boolean; shownAt: number } | null = null;

  private calibrating: boolean;
  private calibBlock = 0;
  private staircase: StaircaseState;

  private blockIndex = 0;
  private numBlocks: number;
  private numTrials: number;
  private onlyCreateNumTrials: boolean;
  private announceBlock = false;
  private autoContinue = false;
  private forceBlockEnd = false;
  private forceGameEnd = false;

  private created = 0;
  private destroyed = 0;
  private caught = 0;
  private missed = 0;
  private alive = 0;

  private ballSpeed: number;
  private spawnTimeMs: number;
  private readonly stayChance: number;
  private lastBallTime = 0;
  private dropLane: number = GEOMETRY.middleLane;
  private nextBallId = 1;
  private balls: Ball[] = [];

  private catcherLane: number = GEOMETRY.middleLane;
  private catcherX = laneX(GEOMETRY.middleLane);
  private readonly spring = new Spring(0, 0, 200, 0.1, 0.5, 100);

  constructor(private readonly init: ExperimentInit) {
    this.cfg = init.config;
    this.rng = new Rng(init.seed);
    this.adminControlled = this.cfg.adminControl.enabled;
    this.spring.setDampingCritical();
    this.calibrating = this.cfg.calibration.enabled;
    this.numBlocks = this.cfg.numBlocks;
    this.numTrials = this.calibrating ? this.cfg.calibration.numTrials : this.cfg.numTrials;
    this.onlyCreateNumTrials = this.calibrating ? true : this.cfg.onlyCreateNumTrialsBalls;
    this.ballSpeed = this.cfg.ballSpeed;
    this.spawnTimeMs = this.cfg.ballSpawnTimeMs;
    this.stayChance = this.cfg.laneChangeStayChance;
    this.staircase = initialStaircase(this.cfg.calibration, this.ballSpeed, this.spawnTimeMs);
  }

  on(listener: (e: DomainEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The first BallMagister::Update (the "virgin" branch) plus firstLogAction. */
  start(): void {
    if (this.phase !== 'not-started') return;
    this.phase = 'running';
    this.emit({
      type: 'session-started',
      version: this.init.version,
      participantId: this.init.participantId,
      seed: this.init.seed,
      config: this.cfg,
    });
    if (this.calibrating) {
      this.calibBlock = this.cfg.calibration.startWithPractice ? -1 : 0;
      this.emit({ type: 'calibration-started' });
      this.emitCalibrationBlockStarted();
      this.showScreen('calibration-intro', !this.adminControlled);
    } else {
      this.resetForNextBlock();
      this.announceBlock = true;
      this.update(); // at t=0, as in the original
    }
  }

  /** Advance by `dtMs` of real time. Experiment time only moves while running. */
  advance(dtMs: number): void {
    if (this.phase === 'not-started' || this.phase === 'ended') return;
    this.stepRemainder += dtMs;
    let steps = Math.floor(this.stepRemainder / Experiment.STEP_MS);
    this.stepRemainder -= steps * Experiment.STEP_MS;
    steps = Math.min(steps, MAX_STEPS_PER_ADVANCE);
    for (let i = 0; i < steps && !this.ended; i++) {
      this.tSys += Experiment.STEP_MS;
      if (this.phase === 'running') {
        this.tExp += Experiment.STEP_MS;
        this.tick(Experiment.STEP_MS);
      } else if (this.phase === 'paused') {
        this.checkAutoContinue();
      }
    }
  }

  dispatch(cmd: ExperimentCommand): void {
    switch (cmd.type) {
      case 'move':
        if (this.phase === 'running') this.moveCatcher(cmd.direction);
        return;
      case 'continue': {
        const s = this.screen;
        if (!s || s.id === 'complete') return;
        // Enter/Continue only works on interactive screens. The hidden 9 key works on any.
        if (cmd.source === 'participant' && !s.interactive) return;
        this.dismissScreen(cmd.source);
        return;
      }
      case 'quit-key':
        if (this.phase === 'ended') return;
        this.emit({ type: 'experiment-aborted', reason: 'quit-key' });
        this.screen = null;
        this.end();
        return;
      case 'admin':
        this.handleAdmin(cmd.command);
        return;
      case 'admin-link':
        this.emit({ type: 'admin-link', status: cmd.status, peerId: cmd.peerId });
        return;
      case 'clock-sync':
        this.emit({ type: 'clock-sync', peerId: cmd.peerId, offsetMs: cmd.offsetMs, rttMs: cmd.rttMs });
        return;
    }
  }

  status(): ExperimentStatus {
    return {
      sessionId: this.init.sessionId ?? null,
      participantId: this.init.participantId,
      phase: this.phase,
      screen: this.screen ? { id: this.screen.id, interactive: this.screen.interactive } : null,
      adminControlled: this.adminControlled,
      calibrating: this.calibrating,
      calibBlock: this.calibBlock,
      block: this.blockIndex,
      numBlocks: this.numBlocks,
      numTrials: this.numTrials,
      counts: { created: this.created, destroyed: this.destroyed, caught: this.caught, missed: this.missed, alive: this.alive },
      difficulty: { ballSpeed: this.ballSpeed, spawnTimeMs: this.spawnTimeMs, laneStayChance: this.stayChance },
      catcherLane: this.catcherLane,
      tExp: this.tExp,
      tSys: this.tSys,
    };
  }

  snapshot(): ExperimentSnapshot {
    const balls: BallView[] = this.balls.map((b) => ({ id: b.id, x: b.x, z: b.z, rot: b.rot, burnedAt: b.burnedAt }));
    return { ...this.status(), catcherX: this.catcherX, balls };
  }

  // ---- simulation ----------------------------------------------------------------------

  private tick(dt: number): void {
    this.stepCatcher(dt);
    this.stepBalls(dt);
    this.update();
  }

  /** DemoController::Move: ease towards the current lane with the critically damped spring. */
  private stepCatcher(dt: number): void {
    const target = laneX(this.catcherLane);
    const toTarget = target - this.catcherX;
    const dir = toTarget === 0 ? 1 : Math.sign(toTarget);
    this.spring.setPosition(Math.abs(toTarget));
    this.spring.step(dt / 1000);
    this.catcherX = target - dir * this.spring.pos;
  }

  private moveCatcher(direction: 'left' | 'right'): void {
    const lane = direction === 'left' ? this.catcherLane - 1 : this.catcherLane + 1;
    const moved = lane >= 0 && lane < GEOMETRY.laneCount;
    if (moved) this.catcherLane = lane;
    this.emit({
      type: 'catcher-moved',
      direction,
      lane: this.catcherLane,
      legacyColumn: moved ? legacyColumn(this.catcherLane) : null,
    });
  }

  private goToMiddle(): void {
    this.catcherLane = GEOMETRY.middleLane;
    this.catcherX = laneX(GEOMETRY.middleLane);
    this.spring.stop();
  }

  /** BallController::Move plus the catch contact and the burn and kill triggers. */
  private stepBalls(dt: number): void {
    const g = GEOMETRY;
    const survivors: Ball[] = [];
    for (const b of this.balls) {
      b.z -= b.speed * dt;
      b.rot = (b.rot + SPIN_RATE * dt) % (2 * Math.PI);

      if (b.burnedAt === null && b.z <= g.catchZMax && b.z >= g.catchZMin && Math.abs(b.x - this.catcherX) < g.catchHalfWidth) {
        this.caught++;
        this.destroyed++;
        this.alive--;
        this.emit({ type: 'ball-caught', ballId: b.id, lane: b.lane, catcherX: this.catcherX, count: this.caught });
        continue;
      }
      if (b.burnedAt === null && b.z <= g.burnZ) {
        b.burnedAt = this.tSys;
        this.missed++;
        this.emit({ type: 'ball-missed', ballId: b.id, lane: b.lane, catcherLane: this.catcherLane, count: this.missed });
      }
      if (b.z <= g.killZ) {
        this.destroyed++;
        this.alive--;
        this.emit({ type: 'ball-removed', ballId: b.id });
        continue;
      }
      survivors.push(b);
    }
    this.balls = survivors;
  }

  /** The part of BallMagister::Update that runs while unpaused. */
  private update(): void {
    const infiniteTrials = this.adminControlled && this.cfg.adminControl.infiniteTrials;
    if ((this.adminControlled && this.forceBlockEnd) || ((this.calibrating || !infiniteTrials) && this.destroyed >= this.numTrials)) {
      const forced = this.forceBlockEnd;
      this.forceBlockEnd = false;
      if (this.calibrating) this.endCalibrationBlock(forced);
      else this.endExperimentBlock(forced);
      return;
    }

    if (this.announceBlock) {
      this.announceBlock = false;
      if (this.blockIndex === 0) this.showScreen('block-intro', !this.adminControlled);
      this.emit({ type: 'block-started', block: this.blockIndex });
      // The original goes on to the spawn check while paused, so a ball could appear behind
      // the intro screen. Wait until it is dismissed.
      if (this.phase !== 'running') return;
    }

    if (this.tExp >= this.lastBallTime + this.spawnTimeMs) {
      this.lastBallTime = this.tExp;
      this.dropLane = nextDropLane(
        this.dropLane,
        { mode: this.cfg.dropMode, laneCount: GEOMETRY.laneCount, stayChance: this.stayChance, neighborhoodSize: this.cfg.laneNeighborhoodSize },
        this.rng,
      );
      if (!this.onlyCreateNumTrials || this.created < this.numTrials) this.spawnBall();
    }
  }

  private spawnBall(): void {
    const ball: Ball = {
      id: this.nextBallId++,
      lane: this.dropLane,
      x: laneX(this.dropLane),
      z: GEOMETRY.dropZ,
      speed: this.ballSpeed,
      rot: 0,
      burnedAt: null,
    };
    this.balls.push(ball);
    this.created++;
    this.alive++;
    this.emit({ type: 'ball-spawned', ballId: ball.id, lane: ball.lane, speed: ball.speed });
  }

  // ---- blocks and calibration ------------------------------------------------------------

  private endCalibrationBlock(forced: boolean): void {
    const cal = this.cfg.calibration;
    const r = stepStaircase(this.staircase, this.calibBlock, this.caught, this.missed, cal);
    this.staircase = r.next;
    this.emit({
      type: 'calibration-block-ended',
      calibBlock: this.calibBlock,
      missed: this.missed,
      caught: this.caught,
      dropped: this.created,
      adjustDir: r.next.adjustDir,
      flipCount: r.next.flipCount,
      catchRate: r.catchRate,
    });

    if (this.forceGameEnd) {
      // Admin quit during calibration: stop here. (The original would keep calibrating.)
      this.finishExperiment(forced);
      return;
    }

    if (r.done) {
      this.calibrating = false;
      this.emit({
        type: 'calibration-ended',
        reason: r.reason ?? 'target-hit',
        ballSpeed: this.ballSpeed,
        spawnTimeMs: this.spawnTimeMs,
        laneStayChance: this.stayChance,
      });
      this.resetForNextBlock();
      this.showScreen('calibration-complete', true);
      this.announceBlock = true;
      return;
    }

    this.autoContinue = cal.autoContinueMs > 0;
    this.showScreen('calibration-break', !this.autoContinue);
    this.clearBlockState();
    this.onlyCreateNumTrials = true;
    if (this.calibBlock >= 0) {
      this.ballSpeed = r.next.ballSpeed;
      this.spawnTimeMs = r.next.spawnTimeMs;
    }
    this.calibBlock++;
    this.emitCalibrationBlockStarted();
  }

  private endExperimentBlock(forced: boolean): void {
    this.emit({
      type: 'block-ended',
      block: this.blockIndex,
      missed: this.missed,
      caught: this.caught,
      dropped: this.created,
      forcedByAdmin: forced,
    });
    this.blockIndex++;
    if ((this.adminControlled && this.forceGameEnd) || this.blockIndex >= this.numBlocks) {
      this.finishExperiment(this.forceGameEnd);
    } else {
      this.resetForNextBlock();
      this.showScreen('block-break', !this.adminControlled);
      this.announceBlock = true;
    }
  }

  private finishExperiment(forced: boolean): void {
    this.emit({ type: 'experiment-ended', forcedByAdmin: forced });
    this.clearBlockState();
    this.showScreen('complete', false);
    this.end();
  }

  /** BallMagister::resetForNextBlock */
  private resetForNextBlock(): void {
    this.clearBlockState();
    this.onlyCreateNumTrials = this.cfg.onlyCreateNumTrialsBalls;
    this.numTrials = this.adminControlled && this.cfg.adminControl.infiniteTrials ? INFINITE : this.cfg.numTrials;
    if (this.adminControlled && this.cfg.adminControl.infiniteBlocks) this.numBlocks = INFINITE;
    this.autoContinue = false;
  }

  /** Reset counters, clear balls, put the catcher and the drop lane back in the middle. */
  private clearBlockState(): void {
    this.created = 0;
    this.destroyed = 0;
    this.caught = 0;
    this.missed = 0;
    this.alive = 0;
    this.balls = [];
    this.dropLane = GEOMETRY.middleLane;
    this.goToMiddle();
  }

  private emitCalibrationBlockStarted(): void {
    this.emit({
      type: 'calibration-block-started',
      calibBlock: this.calibBlock,
      ballSpeed: this.ballSpeed,
      spawnTimeMs: this.spawnTimeMs,
      laneStayChance: this.stayChance,
    });
  }

  // ---- screens and admin -----------------------------------------------------------------

  private showScreen(id: ScreenId, interactive: boolean): void {
    this.screen = { id, interactive, shownAt: this.tSys };
    if (this.phase !== 'ended') this.phase = 'paused';
    this.emit({ type: 'screen-shown', screen: id, interactive });
  }

  private dismissScreen(by: ContinueSource): void {
    const s = this.screen;
    if (!s || s.id === 'complete') return;
    this.screen = null;
    this.phase = 'running';
    if (s.id === 'calibration-break') this.autoContinue = false;
    this.emit({ type: 'screen-dismissed', screen: s.id, by });
  }

  private checkAutoContinue(): void {
    const s = this.screen;
    if (s?.id === 'calibration-break' && this.autoContinue && this.tSys - s.shownAt >= this.cfg.calibration.autoContinueMs) {
      this.dismissScreen('auto');
    }
  }

  private handleAdmin(command: AdminCommandName): void {
    const onBreak = this.screen !== null && this.screen.id !== 'complete';
    let accepted = this.adminControlled && this.phase !== 'ended' && this.phase !== 'not-started';
    if (accepted) {
      switch (command) {
        case 'block-start':
          accepted = onBreak;
          break;
        case 'block-end':
          // The original queues this until the next unpause, which silently ends the block
          // that follows. Only accept it while a block is actually running.
          accepted = this.phase === 'running';
          if (accepted) this.forceBlockEnd = true;
          break;
        case 'quit':
          this.forceBlockEnd = true;
          this.forceGameEnd = true;
          break;
      }
    }
    this.emit({ type: 'admin-command', command, accepted });
    if (accepted && (command === 'block-start' || command === 'quit') && onBreak) this.dismissScreen('admin');
  }

  private end(): void {
    this.phase = 'ended';
  }

  private get ended(): boolean {
    return this.phase === 'ended';
  }

  private emit(payload: Payload<DomainEvent>): void {
    const e = { ...payload, tExp: this.tExp, tSys: this.tSys } as DomainEvent;
    for (const l of this.listeners) l(e);
  }
}
