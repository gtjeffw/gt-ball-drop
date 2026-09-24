import { describe, expect, it } from 'vitest';
import { importLegacyVariables, resolveConfig } from '../src';

describe('importLegacyVariables', () => {
  it('maps GT Ball Drop variables, including the world path, and reports the rest', () => {
    const r = importLegacyVariables(
      [
        '$applicName = "GTBallDrop";',
        '$GTBallNumTrials = "12";',
        '$GTBallDropMode = "2";',
        '$GTBallCalMode = "0";',
        '$GTBallNetworkSlaveMode = "1";',
        '$GTBallWorldFilePath = "world/GTBallDrop_NO_PT_LIGHTS";',
        '$GTBallBallModelPath = "model/GTBall_BLUE";',
      ].join('\r\n'),
    );
    expect(r.config).toMatchObject({ numTrials: 12, dropMode: 'neighborhood', appearance: { world: 'classic' }, calibration: { enabled: false }, adminControl: { enabled: true } });
    expect(r.ignored).toEqual(['GTBallBallModelPath']);
    expect(r.unknown).toEqual(['applicName']);
    expect(resolveConfig(r.config).appearance).toEqual({ world: 'classic', flameHeightScale: 0.5, flameOpacity: 0.7, modelShading: 1 });
  });

  it('recognises the clean world and falls back to lane mode on a bad drop mode, as the original did', () => {
    const r = importLegacyVariables('$GTBallWorldFilePath = "world/GTBallDrop_clean";\n$GTBallDropMode = "7";');
    expect(r.config.appearance?.world).toBe('clean');
    expect(r.config.dropMode).toBe('lane');
  });
});
