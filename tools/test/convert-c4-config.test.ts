import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '@gtbd/protocol';
import { convertC4Config } from '../convert-c4-config';

describe('convertC4Config', () => {
  it('converts GT Ball Drop variables, fills the rest with the C4 defaults, and reports what it skipped', () => {
    const r = convertC4Config(
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
    expect(r.config).toMatchObject({ numTrials: 12, dropMode: 'neighborhood', calibration: { enabled: false }, remoteControl: { enabled: true } });
    expect(r.config.appearance).toEqual({ ...DEFAULT_CONFIG.appearance, world: 'classic' });
    // Not in the file: what the C4 version would have used, not today's defaults.
    expect(r.config).toMatchObject({ numBlocks: 3, ballSpeed: 0.001, ballSpawnTimeMs: 750, laneChangeStayChance: 50 });
    expect(r.config.calibration).toMatchObject({ enabled: false, numTrials: 5, speedIncr: 0.003 });
    expect(convertC4Config('').config.calibration.enabled).toBe(true);
    expect(r.ignored).toEqual(['GTBallBallModelPath']);
    expect(r.unknown).toEqual(['applicName']);
  });

  it('recognises the clean world and falls back to lane mode on a bad drop mode', () => {
    const r = convertC4Config('$GTBallWorldFilePath = "world/GTBallDrop_clean";\n$GTBallDropMode = "7";');
    expect(r.config.appearance.world).toBe('clean');
    expect(r.config.dropMode).toBe('lane');
  });
});
