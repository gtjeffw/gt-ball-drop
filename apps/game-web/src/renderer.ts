import * as THREE from 'three';
import { GEOMETRY, laneX } from '@gtbd/core';
import type { DomainEvent, ExperimentSnapshot } from '@gtbd/protocol';

/**
 * Three.js view of the experiment. It only reads snapshots and events; it never changes
 * experiment state. The layout comes from GEOMETRY, which was measured from the original
 * world file. Materials and effects are approximations of the C4 look.
 */
export class Renderer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly catcher = new THREE.Group();
  // Poles on +Z, so the stripes run vertically and the spin about Z shows.
  private readonly ballGeo = new THREE.SphereGeometry(GEOMETRY.ballRadius, 24, 16).rotateX(Math.PI / 2);
  private readonly ballMat: THREE.MeshStandardMaterial;
  private readonly balls = new Map<number, { mesh: THREE.Mesh; flame: Flame | null }>();
  private readonly pits: Flame[] = [];
  private readonly sparks: Sparks[] = [];
  private readonly flameTexture = makeFlameTexture();

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.scene.background = new THREE.Color(0x1b1e24);

    const [cx, cy, cz] = GEOMETRY.camera.position;
    const [lx, ly, lz] = GEOMETRY.camera.lookAt;
    this.camera = new THREE.PerspectiveCamera(58, GEOMETRY.displayAspect, 0.1, 100);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(cx, cy, cz);
    this.camera.lookAt(lx, ly, lz);

    this.scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x303030, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-4, -10, 14);
    this.scene.add(sun);

    this.buildStage();
    this.buildCatcher();
    this.ballMat = new THREE.MeshStandardMaterial({ map: makeStripeTexture(), roughness: 0.4, metalness: 0.1 });

    // The "Fire Pits": a red fire under every lane, as in the original world.
    for (let lane = 0; lane < GEOMETRY.laneCount; lane++) {
      const f = new Flame(this.flameTexture, 0xff5522, 26, 0.9, 1.1);
      f.group.position.set(laneX(lane), GEOMETRY.laneY, -1.6);
      this.scene.add(f.group);
      this.pits.push(f);
    }
  }

  private buildStage(): void {
    const y = GEOMETRY.laneY;
    const halfSpan = (GEOMETRY.laneCount * GEOMETRY.laneSpacing) / 2;
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(40, 30), new THREE.MeshStandardMaterial({ color: 0x3a3f4a, roughness: 0.95 }));
    wall.rotation.x = Math.PI / 2;
    wall.position.set(0, y + 2.5, 4);
    this.scene.add(wall);

    const pitFloor = new THREE.Mesh(new THREE.BoxGeometry(halfSpan * 2, 2, 0.2), new THREE.MeshStandardMaterial({ color: 0x2a1a14, roughness: 1 }));
    pitFloor.position.set(0, y, -2.6);
    this.scene.add(pitFloor);

    // Lane dividers: thin posts between lanes and at both edges (8 "Dividers" in the original).
    const postMat = new THREE.MeshStandardMaterial({ color: 0x8a8f99, metalness: 0.6, roughness: 0.35 });
    const postGeo = new THREE.CylinderGeometry(0.06, 0.06, 13, 12);
    for (let i = 0; i <= GEOMETRY.laneCount; i++) {
      const post = new THREE.Mesh(postGeo, postMat);
      post.rotation.x = Math.PI / 2; // cylinder axis to +Z
      post.position.set(GEOMETRY.firstLaneX - GEOMETRY.laneSpacing / 2 + i * GEOMETRY.laneSpacing, y, 4);
      this.scene.add(post);
    }
  }

  /** Red ring + disc base (BallCatcher_RED: a torus and a cylinder, radius ~0.5). */
  private buildCatcher(): void {
    const mat = new THREE.MeshStandardMaterial({ color: 0xd11a1a, roughness: 0.35, metalness: 0.2 });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.08, 16, 48), mat);
    ring.position.z = 0.13;
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.05, 40), mat);
    base.rotation.x = Math.PI / 2;
    base.position.z = 0.05;
    this.catcher.add(ring, base);
    this.catcher.position.set(laneX(GEOMETRY.middleLane), GEOMETRY.laneY, GEOMETRY.catcherZ);
    this.scene.add(this.catcher);
  }

  handleEvent(e: DomainEvent): void {
    if (e.type === 'ball-caught') {
      const s = new Sparks(new THREE.Vector3(e.catcherX, GEOMETRY.laneY, GEOMETRY.catcherZ + 0.3), e.tSys);
      this.scene.add(s.points);
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
        entry = { mesh: new THREE.Mesh(this.ballGeo, this.ballMat), flame: null };
        this.scene.add(entry.mesh);
        this.balls.set(b.id, entry);
      }
      entry.mesh.position.set(b.x, GEOMETRY.laneY, b.z);
      entry.mesh.rotation.z = b.rot;
      if (b.burnedAt !== null && !entry.flame) {
        // A missed ball catches (blue) fire, like BallController::Burn.
        entry.flame = new Flame(this.flameTexture, 0x3a7bff, 18, 0.55, 0.8);
        this.scene.add(entry.flame.group);
      }
      if (entry.flame) {
        entry.flame.group.position.set(b.x, GEOMETRY.laneY - 0.1, b.z);
        entry.flame.update(s.tSys);
      }
    }
    for (const [id, entry] of this.balls) {
      if (seen.has(id)) continue;
      this.scene.remove(entry.mesh);
      if (entry.flame) {
        this.scene.remove(entry.flame.group);
        entry.flame.dispose();
      }
      this.balls.delete(id);
    }

    for (const p of this.pits) p.update(s.tSys);
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const sp = this.sparks[i]!;
      if (!sp.update(s.tSys)) {
        this.scene.remove(sp.points);
        sp.dispose();
        this.sparks.splice(i, 1);
      }
    }
    this.renderer.render(this.scene, this.camera);
  }
}

/** Cheap flame: additive sprites that flicker up and fade. */
class Flame {
  readonly group = new THREE.Group();
  private readonly sprites: { s: THREE.Sprite; phase: number; speed: number }[] = [];

  constructor(texture: THREE.Texture, color: number, count: number, width: number, private readonly height: number) {
    for (let i = 0; i < count; i++) {
      const m = new THREE.SpriteMaterial({ map: texture, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
      const s = new THREE.Sprite(m);
      s.position.x = (Math.random() - 0.5) * width;
      this.group.add(s);
      this.sprites.push({ s, phase: Math.random(), speed: 0.6 + Math.random() * 0.8 });
    }
  }

  update(tSys: number): void {
    for (const p of this.sprites) {
      const u = (tSys / 1000 * p.speed + p.phase) % 1;
      p.s.position.z = u * this.height;
      const size = 0.45 * (1 - u) + 0.1;
      p.s.scale.set(size, size, 1);
      p.s.material.opacity = 0.9 * (1 - u);
    }
  }

  dispose(): void {
    for (const p of this.sprites) p.s.material.dispose();
  }
}

/** A short burst of sparks where a ball was caught (the original's SparkSystem). */
class Sparks {
  readonly points: THREE.Points;
  private readonly velocities: Float32Array;
  private readonly origin: THREE.Vector3;
  private static readonly LIFE_MS = 600;

  constructor(origin: THREE.Vector3, private readonly startedAt: number) {
    const n = 60;
    this.origin = origin;
    this.velocities = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const up = 1.5 + Math.random() * 2.5;
      const out = 1 + Math.random() * 2;
      this.velocities.set([Math.cos(a) * out, Math.sin(a) * out * 0.3, up], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.points = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffd36b, size: 0.08, transparent: true }));
  }

  /** Returns false once the burst has finished. */
  update(tSys: number): boolean {
    const t = (tSys - this.startedAt) / 1000;
    if (t * 1000 > Sparks.LIFE_MS) return false;
    const pos = this.points.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      pos.setXYZ(
        i,
        this.origin.x + this.velocities[i * 3]! * t,
        this.origin.y + this.velocities[i * 3 + 1]! * t,
        this.origin.z + this.velocities[i * 3 + 2]! * t - 4.9 * t * t,
      );
    }
    pos.needsUpdate = true;
    (this.points.material as THREE.PointsMaterial).opacity = 1 - (t * 1000) / Sparks.LIFE_MS;
    return true;
  }

  dispose(): void {
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}

function makeFlameTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.5)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/** Two-tone bands so the ball's 1°/ms spin is visible, as on the original's textured ball. */
function makeStripeTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 64;
  const g = c.getContext('2d')!;
  for (let i = 0; i < 8; i++) {
    g.fillStyle = i % 2 ? '#1e4fd8' : '#6e9bff';
    g.fillRect(i * 16, 0, 16, 64);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
