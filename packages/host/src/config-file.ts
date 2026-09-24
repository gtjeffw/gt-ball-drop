import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONFIG, resolveConfig, type ExperimentConfig } from '@gtbd/protocol';

export interface LoadedConfig {
  config: ExperimentConfig;
  source: string;
}

/** Load <dataDir>/config.json, writing the defaults there first if it doesn't exist. */
export function loadExperimentConfig(dataDir: string): LoadedConfig {
  const jsonPath = path.join(dataDir, 'config.json');
  if (fs.existsSync(jsonPath)) {
    return { config: resolveConfig(JSON.parse(fs.readFileSync(jsonPath, 'utf8'))), source: jsonPath };
  }
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
  return { config: DEFAULT_CONFIG, source: `${jsonPath} (defaults written)` };
}
