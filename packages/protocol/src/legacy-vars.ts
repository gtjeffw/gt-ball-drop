import type { DeepPartial, DropMode, ExperimentConfig } from './config';

/**
 * Import a C4 `variables.cfg` from the original build. The syntax is one
 * `$name = "value";` per line. Unknown variables are reported, not rejected, so an
 * old lab config can be dropped in as-is.
 */
export interface LegacyImportResult {
  config: DeepPartial<ExperimentConfig>;
  /** Variables that are recognised but have no effect in the web port (model paths, unknown worlds). */
  ignored: string[];
  /** Variables that are not GT Ball Drop settings at all (engine settings like $displayWidth). */
  unknown: string[];
}

const DROP_MODES: Record<string, DropMode> = { '0': 'random', '1': 'lane', '2': 'neighborhood' };

export function parseLegacyVariables(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*\$(\w+)\s*=\s*"([^"]*)"\s*;?\s*$/.exec(line);
    if (m) vars[m[1]!] = m[2]!;
  }
  return vars;
}

export function importLegacyVariables(text: string): LegacyImportResult {
  const vars = parseLegacyVariables(text);
  const config: DeepPartial<ExperimentConfig> = {};
  const calibration: NonNullable<DeepPartial<ExperimentConfig>['calibration']> = {};
  const adminControl: NonNullable<DeepPartial<ExperimentConfig>['adminControl']> = {};
  const ignored: string[] = [];
  const unknown: string[] = [];

  const int = (v: string) => Number.parseInt(v, 10);
  const num = (v: string) => Number.parseFloat(v);
  const bool = (v: string) => int(v) > 0;

  for (const [name, value] of Object.entries(vars)) {
    switch (name) {
      case 'GTBallParticipantID': config.defaultParticipantId = value; break;
      case 'GTBallNumBlocks': config.numBlocks = int(value); break;
      case 'GTBallNumTrials': config.numTrials = int(value); break;
      case 'GTBallOnlyCreateNumTrialsBalls': config.onlyCreateNumTrialsBalls = bool(value); break;
      case 'GTBallSpawnTimeMS': config.ballSpawnTimeMs = int(value); break;
      case 'GTBallSpeed': config.ballSpeed = num(value); break;
      case 'GTBallLaneChangeStayChance': config.laneChangeStayChance = num(value); break;
      case 'GTBallDropLaneNeighborhoodSize': config.laneNeighborhoodSize = Math.max(1, int(value)); break;
      case 'GTBallDropMode':
        // The original falls back to lane mode on a bad value; do the same.
        config.dropMode = DROP_MODES[value] ?? 'lane';
        break;
      case 'GTBallNetworkSlaveMode': adminControl.enabled = bool(value); break;
      case 'GTBallNetworkForceInfiniteTrial': adminControl.infiniteTrials = bool(value); break;
      case 'GTBallNetworkForceInfiniteBlock': adminControl.infiniteBlocks = bool(value); break;
      case 'GTBallCalMode': calibration.enabled = bool(value); break;
      case 'GTBallCalMaxRefinements': calibration.maxRefinements = int(value); break;
      case 'GTBallCalSpeedIncr': calibration.speedIncr = num(value); break;
      case 'GTBallCalSpeedMin': calibration.speedMin = num(value); break;
      case 'GTBallCalSpawnTimeIncr': calibration.spawnTimeIncrMs = int(value); break;
      case 'GTBallCalSpawnTimeMin': calibration.spawnTimeMinMs = int(value); break;
      case 'GTBallCalSpeedTargetAvg': calibration.targetAvg = num(value); break;
      case 'GTBallCalSpeedTargetAvgErr': calibration.targetAvgErr = num(value); break;
      case 'GTBallCalNumTrials': calibration.numTrials = int(value); break;
      case 'GTBallCallStartWithPractice': calibration.startWithPractice = bool(value); break;
      case 'GTBallWorldFilePath':
        if (/_clean$/i.test(value)) config.appearance = { world: 'clean' };
        else if (/GTBallDrop(_NO_PT_LIGHTS)?$/i.test(value)) config.appearance = { world: 'classic' };
        else ignored.push(name);
        break;
      case 'GTBallCatcherModelPath':
      case 'GTBallBallModelPath':
        ignored.push(name);
        break;
      default:
        unknown.push(name);
    }
  }
  if (Object.keys(calibration).length) config.calibration = calibration;
  if (Object.keys(adminControl).length) config.adminControl = adminControl;
  return { config, ignored, unknown };
}
