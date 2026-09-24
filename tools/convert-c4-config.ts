/**
 * One-time converter from the C4 version's `variables.cfg` to a `config.json`.
 *
 *   npm run convert-c4-config -- path/to/variables.cfg path/to/config.json
 *
 * Settings the file doesn't mention get the current defaults. The app itself only ever
 * reads config.json.
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolveConfig, type DeepPartial, type DropMode, type ExperimentConfig } from '@gtbd/protocol';

export interface ConversionResult {
  config: ExperimentConfig;
  /** GT Ball Drop variables with no equivalent (model paths, unknown world files). */
  ignored: string[];
  /** Other variables in the file, e.g. C4 engine settings like $displayWidth. */
  unknown: string[];
}

const DROP_MODES: Record<string, DropMode> = { '0': 'random', '1': 'lane', '2': 'neighborhood' };

export function convertC4Config(text: string): ConversionResult {
  const vars: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*\$(\w+)\s*=\s*"([^"]*)"\s*;?\s*$/.exec(line);
    if (m) vars[m[1]!] = m[2]!;
  }

  const config: DeepPartial<ExperimentConfig> = {};
  const calibration: NonNullable<DeepPartial<ExperimentConfig>['calibration']> = {};
  const remoteControl: NonNullable<DeepPartial<ExperimentConfig>['remoteControl']> = {};
  const appearance: NonNullable<DeepPartial<ExperimentConfig>['appearance']> = {};
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
      // The C4 version fell back to lane mode on a bad value.
      case 'GTBallDropMode': config.dropMode = DROP_MODES[value] ?? 'lane'; break;
      case 'GTBallNetworkSlaveMode': remoteControl.enabled = bool(value); break;
      case 'GTBallNetworkForceInfiniteTrial': remoteControl.infiniteTrials = bool(value); break;
      case 'GTBallNetworkForceInfiniteBlock': remoteControl.infiniteBlocks = bool(value); break;
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
        if (/_clean$/i.test(value)) appearance.world = 'clean';
        else if (/GTBallDrop(_NO_PT_LIGHTS)?$/i.test(value)) appearance.world = 'classic';
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
  if (Object.keys(remoteControl).length) config.remoteControl = remoteControl;
  if (Object.keys(appearance).length) config.appearance = appearance;
  return { config: resolveConfig(config), ignored, unknown };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output] = process.argv.slice(2);
  if (!input) {
    console.error('usage: npm run convert-c4-config -- <variables.cfg> [config.json]');
    process.exit(2);
  }
  const { config, ignored } = convertC4Config(fs.readFileSync(input, 'utf8'));
  const json = JSON.stringify(config, null, 2) + '\n';
  if (output) {
    fs.writeFileSync(output, json);
    console.error(`wrote ${output}`);
  } else {
    process.stdout.write(json);
  }
  if (ignored.length) console.error(`no equivalent, not converted: ${ignored.join(', ')}`);
}
