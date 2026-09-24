import * as THREE from 'three';
import { GEOMETRY, laneX } from '@gtbd/core';
import type { AppearanceConfig, DomainEvent, ExperimentSnapshot } from '@gtbd/protocol';

/**
 * How the C4 original looked, read from the world file and the engine source. See
 * docs/FIDELITY.md for where each number comes from.
 */
const C4_LOOK = {
  /** ChaseCamera is FrustumCamera(focal 2.0); aspect = height / width = 0.75 at 1024x768. */
  verticalFovDeg: (2 * Math.atan(0.75 / 2) * 180) / Math.PI, // 41.1 (horizontal 53.1)
  /** Infinite zone ambient light. */
  ambient: 0.6157,
  /** The world's one infinite light: white, shining from this direction (its local +Z), shadows on. */
  lightFrom: new THREE.Vector3(-0.00766, -0.5314, 0.8471),
  /** The fog space, identical in both worlds: constant density, white, plane y = 2 facing the camera. */
  fog: { density: 0.05, color: new THREE.Color(1, 1, 1), plane: new THREE.Vector4(0, -1, 0, 2) },
  /** Clear colour: a ClearProperty on the clean world's zone. The classic world has none (black), but draws a skybox. */
  clearColor: { clean: new THREE.Color(1, 1, 0.6275), classic: new THREE.Color(0, 0, 0) },
} as const;

/** C4 did its lighting in gamma space with no colour management, so do the same. */
THREE.ColorManagement.enabled = false;

/** Textures extracted from the original C4 assets (tools/c4-assets/extract.py). */
const C4 = `${import.meta.env.BASE_URL}c4/`;
const loader = new THREE.TextureLoader();

/** C4 textures store the row for v = 0 first, so don't let three.js flip them. */
function c4Texture(path: string, repeat?: [number, number]): THREE.Texture {
  const t = loader.load(C4 + path);
  t.flipY = false;
  t.colorSpace = THREE.NoColorSpace;
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(...repeat);
    t.anisotropy = 8;
  }
  return t;
}

/**
 * Three.js view of the experiment. It only reads snapshots and events; it never changes
 * experiment state.
 */
export class Renderer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly catcher = new THREE.Group();
  private readonly ballGeo = new THREE.SphereGeometry(GEOMETRY.ballRadius, 32, 16).rotateX(Math.PI / 2);
  private readonly ballMat: THREE.MeshPhongMaterial;
  private readonly balls = new Map<number, { mesh: THREE.Mesh; fires: FireEffect[] | null }>();
  private readonly pits: FireEffect[] = [];
  private readonly sparks: Sparks[] = [];
  private readonly ballFlameTexture = c4Texture('texture/blue_flame.png');
  private readonly skybox: THREE.Group | null;
  private readonly modelShading: number;
  private readonly fogUniforms = {
    fogPlane: { value: C4_LOOK.fog.plane },
    fogDensity: { value: C4_LOOK.fog.density },
    fogColor: { value: C4_LOOK.fog.color },
  };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    appearance: AppearanceConfig,
  ) {
    const world = appearance.world;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // no sRGB encode: gamma-space, like C4
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene.background = C4_LOOK.clearColor[world];

    const [cx, cy, cz] = GEOMETRY.camera.position;
    const [lx, ly, lz] = GEOMETRY.camera.lookAt;
    this.camera = new THREE.PerspectiveCamera(C4_LOOK.verticalFovDeg, GEOMETRY.displayAspect, 0.1, 3000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(cx, cy, cz);
    this.camera.lookAt(lx, ly, lz);

    this.skybox = world === 'classic' ? this.makeSkybox('sky/bright') : null;
    if (this.skybox) this.scene.add(this.skybox);

    // three.js's Lambert BRDF divides by pi, so scale by pi to get C4's albedo * (ambient + N.L).
    this.scene.add(new THREE.AmbientLight(0xffffff, C4_LOOK.ambient * Math.PI));
    const sun = new THREE.DirectionalLight(0xffffff, Math.PI);
    sun.position.copy(C4_LOOK.lightFrom).multiplyScalar(100).add(new THREE.Vector3(0, 40, 0));
    sun.target.position.set(0, 40, 0);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 90, bottom: -60, near: 1, far: 400 });
    sun.shadow.bias = -0.0005;
    this.scene.add(sun, sun.target);

    this.modelShading = appearance.modelShading;
    this.buildStage();
    this.buildCatcher();
    // GTBall_BLUE's material: diffuse and emission (0, 0, 1), white specular, exponent 47. No
    // texture, so the ball's 1°/ms spin was invisible.
    this.ballMat = this.fogged(shadedMaterial([0, 0, 1], [0, 0, 1], 47, appearance.modelShading));

    // The "Fire Pits": two FireEffects per lane at (x, 1, -1), as in the world file. Red in
    // the clean world, yellow in the classic one. Height and brightness can be scaled down
    // from the original (appearance.flameHeightScale / flameOpacity).
    const pitTexture = c4Texture(world === 'classic' ? 'texture/Flame.png' : 'texture/red_flame.png');
    for (let lane = 0; lane < GEOMETRY.laneCount; lane++) {
      for (const [radius, height, intensity, speed] of [
        [1, 5, 0.4, 24],
        [1, 1.5, 0.25, 16],
      ] as const) {
        const f = new FireEffect(pitTexture, radius, height * appearance.flameHeightScale, intensity, speed, appearance.flameOpacity);
        f.mesh.position.set(laneX(lane), 1, -1);
        this.scene.add(f.mesh);
        this.pits.push(f);
      }
    }
  }

  /**
   * Add C4's constant-density fog space to a material (ConstantFogProcess in C4Shaders.cpp).
   * Fog fills the half-space behind plane F; the fog factor is exp(-density * d), where d is
   * the length of the view ray inside that half-space.
   */
  private fogged<M extends THREE.Material>(material: M): M {
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.fogUniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vFogWorldPos;')
        .replace('#include <fog_vertex>', '#include <fog_vertex>\nvFogWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          varying vec3 vFogWorldPos;
          uniform vec4 fogPlane;
          uniform float fogDensity;
          uniform vec3 fogColor;`,
        )
        .replace(
          '#include <fog_fragment>',
          `{
            vec3 vdir = cameraPosition - vFogWorldPos;
            float fdtp = dot(fogPlane.xyz, vFogWorldPos) + fogPlane.w;
            float fdtv = dot(fogPlane.xyz, vdir);
            float inside = clamp(-fdtp / abs(fdtv), 0.0, 1.0);
            float f = clamp(exp(-fogDensity * inside * length(vdir)), 0.0, 1.0);
            gl_FragColor.rgb = mix(fogColor, gl_FragColor.rgb, f);
          }`,
        );
    };
    return material;
  }

  /** The measured world geometry. All of it uses the new_wall material (texture/Wall). */
  private buildStage(): void {
    const g = GEOMETRY;
    const wallMat = (repeat: [number, number]) => this.fogged(new THREE.MeshLambertMaterial({ map: c4Texture('texture/Wall.png', repeat) }));

    // Ground: the top face of the 1000-unit slab, from just behind the lanes to the horizon.
    const gw = g.ground.xMax - g.ground.xMin;
    const gd = g.ground.yMax - g.ground.yMin;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(gw, gd), wallMat([gw / 4, gd / 4]));
    ground.position.set((g.ground.xMin + g.ground.xMax) / 2, (g.ground.yMin + g.ground.yMax) / 2, g.ground.zTop);
    ground.receiveShadow = true;
    this.scene.add(ground);

    // Walls between the fire pits, dropping 257 units into the dark.
    const pw = g.pitWalls;
    const wallGeo = new THREE.BoxGeometry(pw.width, pw.yMax - pw.yMin, pw.zMax - pw.zMin);
    const pitMat = wallMat([1, 60]);
    for (let i = 0; i <= g.laneCount; i++) {
      const wall = new THREE.Mesh(wallGeo, pitMat);
      wall.position.set(g.firstLaneX - g.laneSpacing / 2 + i * g.laneSpacing, (pw.yMin + pw.yMax) / 2, (pw.zMin + pw.zMax) / 2);
      wall.receiveShadow = true;
      this.scene.add(wall);
    }

    // Lane dividers: 8 poles rising 200 units from the ground.
    const d = g.dividers;
    const postGeo = new THREE.CylinderGeometry(d.radius, d.radius, d.height, 16);
    const postMat = wallMat([1, 100]);
    for (let i = 0; i <= g.laneCount; i++) {
      const post = new THREE.Mesh(postGeo, postMat);
      post.rotation.x = Math.PI / 2; // cylinder axis to +Z
      post.position.set(g.firstLaneX - g.laneSpacing / 2 + i * g.laneSpacing, d.y, d.height / 2);
      post.castShadow = true;
      this.scene.add(post);
    }
  }

  /**
   * BallCatcher_RED: a torus (r 0.38, tube 0.127) at +0.132 and a disc (r 0.4, 0.152 tall) at
   * +0.054. Material: diffuse (1, 0.02, 0), emission (1, 0, 0), white specular, exponent 27.
   */
  private buildCatcher(): void {
    const mat = this.fogged(shadedMaterial([1, 0.02, 0], [1, 0, 0], 27, this.modelShading));
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.38, 0.127, 16, 48), mat);
    ring.position.z = 0.132;
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.152, 40), mat);
    base.rotation.x = Math.PI / 2;
    base.position.z = 0.054 + 0.076;
    for (const m of [ring, base]) m.castShadow = true;
    this.catcher.add(ring, base);
    this.catcher.position.set(laneX(GEOMETRY.middleLane), GEOMETRY.laneY, GEOMETRY.catcherZ);
    this.scene.add(this.catcher);
  }

  /**
   * The C4 skybox: six faces with exactly C4Skybox.cpp's vertex positions and texture
   * coordinates (Z up; faces 0 +X, 1 -X, 2 +Y, 3 -Y, 4 +Z, 5 -Z). Its flags are 0, so the
   * fog applies to it too, using C4's "infinite vertex" fog: the plane distances are taken
   * at 1024 units out, but the ray length is |camera - v| in the sky cube's own space,
   * which is why the sky came out about half hazed rather than fully white.
   */
  private makeSkybox(dir: string): THREE.Group {
    type Corner = [x: number, y: number, z: number, u: number, v: number];
    const faces: ((a: number, b: number) => Corner)[] = [
      (k, j) => { const z = 1 - k, y = 1 - j; return [1, 2 * y - 1, 2 * z - 1, 1 - y, z]; },
      (k, j) => { const z = 1 - k, y = j; return [-1, 2 * y - 1, 2 * z - 1, y, z]; },
      (k, i) => { const z = 1 - k, x = i; return [2 * x - 1, 1, 2 * z - 1, x, z]; },
      (k, i) => { const z = 1 - k, x = 1 - i; return [2 * x - 1, -1, 2 * z - 1, 1 - x, z]; },
      (j, i) => { const y = 1 - j, x = 1 - i; return [2 * x - 1, 2 * y - 1, 1, 1 - x, y]; },
      (j, i) => { const y = 1 - j, x = i; return [2 * x - 1, 2 * y - 1, -1, x, y]; },
    ];
    const group = new THREE.Group();
    faces.forEach((corner, index) => {
      const pts = [corner(0, 0), corner(0, 1), corner(1, 0), corner(1, 1)];
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pts.flatMap((p) => [p[0], p[1], p[2]]), 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(pts.flatMap((p) => [p[3], p[4]]), 2));
      geo.setIndex([0, 1, 2, 1, 3, 2]);
      const map = c4Texture(`${dir}/${index}.png`);
      map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
      const mat = new THREE.ShaderMaterial({
        uniforms: { map: { value: map }, cameraPos: { value: this.camera.position }, ...this.fogUniforms },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          varying vec3 vDir;
          void main() {
            vUv = uv;
            vDir = position; // the unit-cube vertex, as C4's OPOS
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          uniform sampler2D map;
          uniform vec3 cameraPos;
          uniform vec4 fogPlane;
          uniform float fogDensity;
          uniform vec3 fogColor;
          varying vec2 vUv;
          varying vec3 vDir;
          void main() {
            vec3 far = vDir * 1024.0 + cameraPos;
            float fdtp = dot(fogPlane.xyz, far) + fogPlane.w;
            float fdtv = dot(fogPlane.xyz, vDir) * -1024.0;
            float inside = clamp(-fdtp / abs(fdtv), 0.0, 1.0);
            float f = clamp(exp(-fogDensity * inside * length(cameraPos - vDir)), 0.0, 1.0);
            gl_FragColor = vec4(mix(fogColor, texture2D(map, vUv).rgb, f), 1.0);
          }`,
        side: THREE.DoubleSide,
        depthWrite: false,
        depthTest: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = -1;
      mesh.frustumCulled = false;
      group.add(mesh);
    });
    group.scale.setScalar(1000);
    return group;
  }

  handleEvent(e: DomainEvent): void {
    if (e.type === 'ball-caught') {
      // BallController::Catch puts a SparkSystem(100) at the ball's position.
      const at = this.balls.get(e.ballId)?.mesh.position.clone() ?? new THREE.Vector3(laneX(e.lane), GEOMETRY.laneY, GEOMETRY.catchZMax);
      const s = new Sparks(at, e.tSys);
      this.scene.add(s.mesh);
      this.sparks.push(s);
    }
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  render(s: Pick<ExperimentSnapshot, 'catcherX' | 'balls' | 'tSys'>): void {
    this.catcher.position.x = s.catcherX;

    const seen = new Set<number>();
    for (const b of s.balls) {
      seen.add(b.id);
      let entry = this.balls.get(b.id);
      if (!entry) {
        entry = { mesh: new THREE.Mesh(this.ballGeo, this.ballMat), fires: null };
        entry.mesh.castShadow = true;
        this.scene.add(entry.mesh);
        this.balls.set(b.id, entry);
      }
      entry.mesh.position.set(b.x, GEOMETRY.laneY, b.z);
      entry.mesh.rotation.z = b.rot;
      if (b.burnedAt !== null && !entry.fires) {
        // A missed ball catches fire: BallController::Burn adds two FireEffect(1.5, 5, 0.5, 100)
        // with blue_flame, one at the ball and one at (0, -0.25, -0.25). Speed 100 clamps to 24.
        entry.fires = [new FireEffect(this.ballFlameTexture, 1.5, 5, 0.5, 24), new FireEffect(this.ballFlameTexture, 1.5, 5, 0.5, 24)];
        for (const f of entry.fires) this.scene.add(f.mesh);
      }
      if (entry.fires) {
        entry.fires[0]!.mesh.position.set(b.x, GEOMETRY.laneY - 0.25, b.z - 0.25);
        entry.fires[1]!.mesh.position.set(b.x, GEOMETRY.laneY, b.z);
        for (const f of entry.fires) f.update(this.camera, s.tSys);
      }
    }
    for (const [id, entry] of this.balls) {
      if (seen.has(id)) continue;
      this.scene.remove(entry.mesh);
      for (const f of entry.fires ?? []) {
        this.scene.remove(f.mesh);
        f.dispose();
      }
      this.balls.delete(id);
    }

    this.skybox?.position.copy(this.camera.position);
    for (const p of this.pits) p.update(this.camera, s.tSys);
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const sp = this.sparks[i]!;
      if (!sp.update(s.tSys, this.camera)) {
        this.scene.remove(sp.mesh);
        sp.dispose();
        this.sparks.splice(i, 1);
      }
    }
    this.renderer.render(this.scene, this.camera);
  }
}

/**
 * A C4 model material (diffuse, emission, white specular) with optional extra shading:
 * shading 0 is the material as authored; shading s scales emission by (1 - s) and diffuse by
 * (1 - 0.45 s), so the lit colour stops saturating and N.L shows.
 */
function shadedMaterial(diffuse: [number, number, number], emission: [number, number, number], shininess: number, shading: number): THREE.MeshPhongMaterial {
  const d = 1 - 0.45 * shading;
  const e = 1 - shading;
  return new THREE.MeshPhongMaterial({
    color: new THREE.Color(diffuse[0] * d, diffuse[1] * d, diffuse[2] * d),
    emissive: new THREE.Color(emission[0] * e, emission[1] * e, emission[2] * e),
    specular: new THREE.Color(1, 1, 1),
    shininess,
  });
}

const noiseTexture = c4Texture('texture/noise.png', [1, 1]);

/**
 * Port of C4's FireEffect (C4Effects.cpp) and its fire shader (FireProcess in C4Shaders.cpp).
 * A quad 2*radius wide and `height` tall, rising from its origin and turned about Z to face
 * the camera. The flame texture is sampled through UVs distorted by three scrolling noise
 * lookups, with the distortion growing towards the top (uv.y * intensity). As in C4 it is
 * alpha-tested (alpha > 0) and blended additively (ONE, ONE) at full texture colour.
 */
class FireEffect {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;

  constructor(flame: THREE.Texture, radius: number, height: number, intensity: number, speed: number, gain = 1) {
    const geo = new THREE.BufferGeometry();
    // Quad in the XZ plane facing -Y: (-r,0,0) (r,0,0) (-r,0,h) (r,0,h), uv (0,0) at the base.
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-radius, 0, 0, radius, 0, 0, -radius, 0, height, radius, 0, height], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
    geo.setIndex([0, 1, 2, 1, 3, 2]);
    const [v1, v2, v3] = noiseVelocities(speed);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        flameMap: { value: flame },
        noiseMap: { value: noiseTexture },
        time: { value: 0 },
        intensity: { value: intensity },
        velocity0: { value: new THREE.Vector4(v1[0], v1[1], v2[0], v2[1]) },
        velocity1: { value: new THREE.Vector2(v3[0], v3[1]) },
        offset: { value: new THREE.Vector2(Math.random(), Math.random()) },
        gain: { value: gain },
      },
      vertexShader: /* glsl */ `
        uniform float time;
        uniform float intensity;
        uniform vec4 velocity0;
        uniform vec2 velocity1;
        uniform vec2 offset;
        varying vec3 vFire;
        varying vec4 vFire1;
        varying vec2 vFire2;
        void main() {
          vFire = vec3(uv, uv.y * intensity);
          vec2 t = uv + offset;
          vFire1 = velocity0 * time + t.xyxy;
          vFire2 = velocity1 * time + t;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D flameMap;
        uniform sampler2D noiseMap;
        uniform float gain;
        varying vec3 vFire;
        varying vec4 vFire1;
        varying vec2 vFire2;
        void main() {
          vec2 d = texture2D(noiseMap, vFire1.xy).xy * 2.0 - 3.0;
          d += texture2D(noiseMap, vFire1.zw).xy * 2.0;
          d += texture2D(noiseMap, vFire2).xy * 2.0;
          vec4 c = texture2D(flameMap, clamp(vFire.xy + d * vFire.z, 0.0, 1.0));
          if (c.a <= 0.0) discard;
          gl_FragColor = vec4(c.rgb * gain, 1.0);
        }`,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
  }

  /** Face the camera (rotation about Z only) and advance the shader clock (ms). */
  update(camera: THREE.Camera, timeMs: number): void {
    const dx = camera.position.x - this.mesh.position.x;
    const dy = camera.position.y - this.mesh.position.y;
    this.mesh.rotation.z = Math.atan2(dy, dx) + Math.PI / 2;
    this.material.uniforms.time!.value = timeMs;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

/** FireAttribute::CalculateNoiseVelocities: noise scroll speeds in uv per ms. */
function noiseVelocities(speed: number): [[number, number], [number, number], [number, number]] {
  const fireData: [number, number, number, number, number][] = [
    [3, 7, 13, 0, 3], [5, 11, 23, 1, 4], [7, 13, 29, 1, 5], [11, 23, 47, 2, 6], [13, 29, 53, 3, 7],
    [17, 37, 67, 4, 9], [19, 41, 79, 4, 10], [23, 47, 97, 4, 11], [29, 59, 113, 5, 12], [31, 61, 127, 5, 14],
    [37, 73, 149, 5, 15], [41, 83, 163, 6, 16], [43, 89, 173, 6, 17], [47, 97, 191, 6, 18], [53, 107, 211, 7, 20],
    [59, 113, 239, 8, 22], [61, 127, 241, 9, 22], [67, 137, 269, 9, 24], [71, 139, 283, 9, 24], [73, 149, 293, 9, 25],
    [79, 157, 317, 10, 28], [83, 167, 331, 10, 30], [89, 179, 359, 10, 31], [97, 193, 389, 11, 32], [101, 199, 401, 11, 33],
  ];
  const redSpeed = [1, 2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97, 101, 101, 103, 107, 109, 113, 127, 131];
  const inversePeriod = 1 / 120000;
  const [g1, g2, g3, min, max] = fireData[Math.max(0, Math.min(speed, fireData.length - 1))]!;
  const red = () => redSpeed[min + Math.floor(Math.random() * (max - min + 1))]! * inversePeriod * (Math.random() < 0.5 ? -1 : 1);
  return [
    [red(), -g1 * inversePeriod],
    [red(), -g2 * inversePeriod],
    [red(), -g3 * inversePeriod],
  ];
}

/** C4's built-in particle texture (C4Particles.cpp): 16x16 luminance, a sharp peak. */
const PARTICLE_TEXTURE = (() => {
  const img = [
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x03, 0x03, 0x02, 0x01, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x03, 0x05, 0x07, 0x08, 0x09, 0x08, 0x07, 0x05, 0x03, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x03, 0x06, 0x0a, 0x0d, 0x0f, 0x0f, 0x0f, 0x0d, 0x0a, 0x06, 0x03, 0x00, 0x00,
    0x00, 0x00, 0x03, 0x06, 0x0b, 0x0f, 0x14, 0x18, 0x19, 0x18, 0x14, 0x0f, 0x0b, 0x06, 0x03, 0x00,
    0x00, 0x01, 0x05, 0x0a, 0x0f, 0x16, 0x1e, 0x25, 0x27, 0x25, 0x1e, 0x16, 0x0f, 0x0a, 0x05, 0x01,
    0x00, 0x02, 0x07, 0x0d, 0x14, 0x1e, 0x2b, 0x38, 0x3f, 0x38, 0x2b, 0x1e, 0x14, 0x0d, 0x07, 0x02,
    0x00, 0x03, 0x08, 0x0f, 0x18, 0x25, 0x38, 0x56, 0x6f, 0x56, 0x38, 0x25, 0x18, 0x0f, 0x08, 0x03,
    0x00, 0x03, 0x09, 0x0f, 0x19, 0x27, 0x3f, 0x6f, 0xff, 0x6f, 0x3f, 0x27, 0x19, 0x0f, 0x09, 0x03,
    0x00, 0x03, 0x08, 0x0f, 0x18, 0x25, 0x38, 0x56, 0x6f, 0x56, 0x38, 0x25, 0x18, 0x0f, 0x08, 0x03,
    0x00, 0x02, 0x07, 0x0d, 0x14, 0x1e, 0x2b, 0x38, 0x3f, 0x38, 0x2b, 0x1e, 0x14, 0x0d, 0x07, 0x02,
    0x00, 0x01, 0x05, 0x0a, 0x0f, 0x16, 0x1e, 0x25, 0x27, 0x25, 0x1e, 0x16, 0x0f, 0x0a, 0x05, 0x01,
    0x00, 0x00, 0x03, 0x06, 0x0b, 0x0f, 0x14, 0x18, 0x19, 0x18, 0x14, 0x0f, 0x0b, 0x06, 0x03, 0x00,
    0x00, 0x00, 0x00, 0x03, 0x06, 0x0a, 0x0d, 0x0f, 0x0f, 0x0f, 0x0d, 0x0a, 0x06, 0x03, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x03, 0x05, 0x07, 0x08, 0x09, 0x08, 0x07, 0x05, 0x03, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x03, 0x03, 0x02, 0x01, 0x00, 0x00, 0x00, 0x00,
  ];
  const rgba = new Uint8Array(16 * 16 * 4);
  img.forEach((l, i) => rgba.set([l, l, l, 255], i * 4));
  const t = new THREE.DataTexture(rgba, 16, 16);
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
})();

/**
 * Port of GTBallDrop's SparkSystem (Effects.cpp) drawn as C4 line particles (C4Particles.cpp):
 * 100 blue particles, each living 0-749 ms, launched in a random direction at up to
 * 0.04 units/ms, falling under C4's gravity (-9.8e-6 units/ms²) and fading over their last
 * 100 ms. Each is a camera-facing streak along its velocity, 16.67 ms of travel long and
 * 2 × 0.25 wide, textured with C4's particle texture and blended (SRC_ALPHA, ONE).
 */
class Sparks {
  readonly mesh: THREE.Mesh;
  private static readonly COUNT = 100;
  private static readonly RADIUS = 0.25;
  private static readonly GRAVITY = -9.8e-6;
  private static readonly NORMALIZATION_MS = 16.666666;
  private readonly pos: THREE.Vector3[] = [];
  private readonly vel: THREE.Vector3[] = [];
  private readonly life: number[] = [];
  private lastT: number;
  private readonly geo = new THREE.BufferGeometry();

  constructor(origin: THREE.Vector3, startedAt: number) {
    const n = Sparks.COUNT;
    for (let i = 0; i < n; i++) {
      const phi = (Math.floor(Math.random() * 128) / 256) * 2 * Math.PI;
      const theta = (Math.floor(Math.random() * 256) / 256) * 2 * Math.PI;
      const speed = Math.random() * 0.04;
      const sp = Math.sin(phi) * speed;
      this.pos.push(origin.clone());
      this.vel.push(new THREE.Vector3(Math.cos(theta) * sp, Math.sin(theta) * sp, Math.cos(phi) * speed));
      this.life.push(Math.floor(Math.random() * 750));
    }
    this.lastT = startedAt;
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 4 * 3), 3));
    this.geo.setAttribute('alpha', new THREE.BufferAttribute(new Float32Array(n * 4), 1));
    const uv = new Float32Array(n * 8);
    const index: number[] = [];
    for (let i = 0; i < n; i++) {
      uv.set([0, 0, 1, 0, 1, 1, 0, 1], i * 8);
      index.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
    }
    this.geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.geo.setIndex(index);
    const material = new THREE.ShaderMaterial({
      uniforms: { map: { value: PARTICLE_TEXTURE } },
      vertexShader: /* glsl */ `
        attribute float alpha;
        varying float vAlpha;
        varying vec2 vUv;
        void main() {
          vAlpha = alpha;
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D map;
        varying float vAlpha;
        varying vec2 vUv;
        void main() {
          gl_FragColor = vec4(vec3(0.0, 0.0, 1.0) * texture2D(map, vUv).r, vAlpha);
        }`,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendSrc: THREE.SrcAlphaFactor,
      blendDst: THREE.OneFactor,
    });
    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.frustumCulled = false;
  }

  /** SparkSystem::AnimateParticles, then build the streaks. Returns false once every particle has died. */
  update(tSys: number, camera: THREE.Camera): boolean {
    const dt = Math.max(0, tSys - this.lastT);
    this.lastT = tSys;
    const posAttr = this.geo.getAttribute('position') as THREE.BufferAttribute;
    const alphaAttr = this.geo.getAttribute('alpha') as THREE.BufferAttribute;
    const toCam = new THREE.Vector3();
    const axis = new THREE.Vector3();
    const side = new THREE.Vector3();
    const half = new THREE.Vector3();
    let alive = 0;
    for (let i = 0; i < Sparks.COUNT; i++) {
      this.life[i]! -= dt;
      const life = this.life[i]!;
      const p = this.pos[i]!;
      const v = this.vel[i]!;
      let a = 0;
      if (life > 0) {
        v.z += Sparks.GRAVITY * dt;
        p.addScaledVector(v, dt);
        a = life < 100 ? life * 0.01 : 1;
        alive++;
      }
      half.copy(v).multiplyScalar(Sparks.NORMALIZATION_MS * 0.5);
      axis.copy(v).normalize();
      if (axis.lengthSq() === 0) axis.set(0, 0, 1);
      toCam.copy(camera.position).sub(p).normalize();
      side.crossVectors(axis, toCam).normalize().multiplyScalar(Sparks.RADIUS);
      const along = axis.clone().multiplyScalar(Sparks.RADIUS).add(half);
      const tail = p.clone().sub(along);
      const head = p.clone().add(along);
      posAttr.setXYZ(i * 4, tail.x - side.x, tail.y - side.y, tail.z - side.z);
      posAttr.setXYZ(i * 4 + 1, head.x - side.x, head.y - side.y, head.z - side.z);
      posAttr.setXYZ(i * 4 + 2, head.x + side.x, head.y + side.y, head.z + side.z);
      posAttr.setXYZ(i * 4 + 3, tail.x + side.x, tail.y + side.y, tail.z + side.z);
      for (let k = 0; k < 4; k++) alphaAttr.setX(i * 4 + k, a);
    }
    posAttr.needsUpdate = true;
    alphaAttr.needsUpdate = true;
    return alive > 0;
  }

  dispose(): void {
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
