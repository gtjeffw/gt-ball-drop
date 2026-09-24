import type { DomainEvent } from '@gtbd/protocol';

/**
 * Writes the C4 original's `event_log.txt` format from domain events, so existing
 * analysis scripts keep working. The file is an export; the structured events are the
 * source of truth.
 *
 * Each line is `<seconds>,<TOKEN>[,args...]` with CRLF endings, timestamped with
 * experiment time (which stops during pauses), as in Game::WriteLog.
 */
export const LEGACY_EOL = '\r\n';

export function legacyTimestamp(tExpMs: number): string {
  return (tExpMs / 1000).toFixed(3);
}

function f(x: number): string {
  return String(Number(x.toPrecision(6)));
}

/** The body text of the legacy line(s) an event maps to, without timestamps. Most new event types map to none. */
export function legacyTokens(e: DomainEvent): string[] {
  switch (e.type) {
    case 'session-started':
      return [`GTBALLDROP_VERSION,${e.version}`, 'EXPERIMENT_BEGIN', `PARTICIPANT_ID,${e.participantId}`];
    case 'calibration-started':
      return ['BEGIN_CALIB'];
    case 'calibration-block-started':
      return [
        `BEGIN_CALIB_BLOCK,${e.calibBlock}`,
        'CALIB_CONFIG_DESCRIPT,BALL_SPEED,BALL_SPAWN_TIME_MS,LANE_STAY_CHANCE',
        `CALIB_CONFIG,${f(e.ballSpeed)},${e.spawnTimeMs},${f(e.laneStayChance)}`,
      ];
    case 'calibration-block-ended':
      return [
        `END_CALIB_BLOCK,${e.calibBlock}`,
        'CALIB_BLOCK_RESULTS_DESCRIPT,BLOCK_NUM,NUM_MISSED,NUM_CAUGHT,NUM_DROPPED,ADJUST_DIR,FLIP_COUNT',
        `CALIB_BLOCK_RESULTS,${e.calibBlock},${e.missed},${e.caught},${e.dropped},${e.adjustDir},${e.flipCount}`,
      ];
    case 'calibration-ended':
      return [
        'END_CALIB',
        'CALIB_RESULTS_DESCRIPT,BALL_SPEED,BALL_SPAWN_TIME_MS,LANE_STAY_CHANCE',
        `CALIB_RESULTS,${f(e.ballSpeed)},${e.spawnTimeMs},${f(e.laneStayChance)}`,
      ];
    case 'block-started':
      return [`BEGIN_BLOCK,${e.block}`];
    case 'block-ended':
      return [
        `END_BLOCK,${e.block}`,
        'BLOCK_RESULTS_DESCRIPT,BLOCK_NUM,NUM_MISSED,NUM_CAUGHT,NUM_DROPPED',
        `BLOCK_RESULTS,${e.block},${e.missed},${e.caught},${e.dropped}`,
      ];
    case 'experiment-ended':
      return ['EXPERIMENT_END'];
    case 'ball-caught':
      return [`BALL_CAUGHT,${e.count}`];
    case 'ball-missed':
      return [`BALL_MISSED,${e.count}`];
    case 'catcher-moved':
      return e.legacyColumn === null ? [] : [`BALL_CATCHER_${e.direction === 'left' ? 'LEFT' : 'RIGHT'},${e.legacyColumn}`];
    case 'admin-link':
      return [e.status === 'connected' ? 'NETWORK_MASTER_SOCKET_CONNECTED' : 'NETWORK_ERR_MASTER_SOCKET_LOST'];
    default:
      return [];
  }
}

export function legacyLines(e: DomainEvent): string {
  const ts = legacyTimestamp(e.tExp);
  return legacyTokens(e).map((t) => `${ts},${t}${LEGACY_EOL}`).join('');
}

/** The DATE and TIME lines at the top of the file (Game::CreateLogFile). */
export function legacyHeader(start: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const date = `${p(start.getMonth() + 1)}/${p(start.getDate())}/${start.getFullYear()}`;
  const time = `${p(start.getHours())}:${p(start.getMinutes())}:${p(start.getSeconds())}`;
  return `${legacyTimestamp(0)},DATE,${date}${LEGACY_EOL}${legacyTimestamp(0)},TIME,${time}${LEGACY_EOL}`;
}
