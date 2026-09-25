import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { packageOf, ROOT, thirdPartyNotices } from '../licenses.mjs';

describe('licence notices', () => {
  it('maps bundled files to their npm package, including scoped and nested ones', () => {
    expect(packageOf('/r/node_modules/three/build/three.module.js')).toEqual({ name: 'three', dir: '/r/node_modules/three' });
    expect(packageOf('/r/node_modules/@scope/pkg/x.js')?.name).toBe('@scope/pkg');
    expect(packageOf('/r/node_modules/a/node_modules/b/i.js')).toEqual({ name: 'b', dir: '/r/node_modules/a/node_modules/b' });
    expect(packageOf('/r/packages/core/src/index.ts')).toBeNull();
  });

  it('includes each package once, with its licence text', () => {
    const three = path.join(ROOT, 'node_modules/three/build/three.module.js');
    const text = thirdPartyNotices([three, three, path.join(ROOT, 'packages/core/src/index.ts')], 'a test');
    expect(text).toMatch(/^Third-party software included in a test\./);
    expect(text).toContain('1 package: three');
    expect(text).toMatch(/three@[\d.]+ \(MIT\)/);
    expect(text).toContain('Permission is hereby granted');
  });
});
