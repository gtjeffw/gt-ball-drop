import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONFIG, importLegacyVariables, resolveConfig, type ExperimentConfig } from '@gtbd/protocol';

export interface LoadedConfig {
  config: ExperimentConfig;
  source: string;
  warnings: string[];
}

/**
 * Load the experiment config from <dataDir>/config.json. If there isn't one and a legacy
 * <dataDir>/variables.cfg exists (copied from an old C4 install), import that instead.
 * Otherwise write the defaults to config.json so there is a file to edit.
 */
export function loadExperimentConfig(dataDir: string): LoadedConfig {
  const jsonPath = path.join(dataDir, 'config.json');
  const legacyPath = path.join(dataDir, 'variables.cfg');
  if (fs.existsSync(jsonPath)) {
    return { config: resolveConfig(JSON.parse(fs.readFileSync(jsonPath, 'utf8'))), source: jsonPath, warnings: [] };
  }
  if (fs.existsSync(legacyPath)) {
    const r = importLegacyVariables(fs.readFileSync(legacyPath, 'utf8'));
    const warnings = r.ignored.map((n) => `${n} has no effect in the web port`);
    return { config: resolveConfig(r.config), source: legacyPath, warnings };
  }
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
  return { config: DEFAULT_CONFIG, source: `${jsonPath} (defaults written)`, warnings: [] };
}
