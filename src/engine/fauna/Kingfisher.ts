import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { KingfisherBrain, type KingfisherEvents, type KingfisherWorld } from '../../sim/fauna/kingfisher';
import { createRng } from '../../sim/rng';

/** A part of the bird: an ellipsoid with a color. */
function part(rx: number, ry: number, rz: number, color: number, at: [number, number, number]): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, 12, 8);
  g.scale(rx, ry, rz);
  g.translate(...at);
  const c = new THREE.Color(color);
  const colors = new Float32Array(g.getAttribute('position').count * 3);
  for (let i = 0; i < colors.length; i += 3) {
    colors[i] = c.r;
    colors[i + 1] = c.g;
    colors[i + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

/** A long pointed beak along +z. */
function beak(): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(0.009, 0.045, 6);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0.012, 0.085);
  const colors = new Float32Array(g.getAttribute('position').count * 3).fill(0.05);
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.deleteAttribute('uv');
  return g;
}

function noUv(g: THREE.BufferGeometry): THREE.BufferGeometry {
  g.deleteAttribute('uv');
  return g;
}

/**
 * The common kingfisher, drawn (plan 6.6): electric blue-turquoise back, orange breast, a long dark beak; wings flap
 * from the shoulders. It follows `KingfisherBrain`, perching near you, flying low along the stream and diving.
 */
export class Kingfisher {
  readonly group = new THREE.Group();
  readonly brain = new KingfisherBrain(createRng('kingfisher'));
  /** Called on each splash (sound, ripples). */
  onSplash: ((x: number, y: number, z: number) => void) | null = null;
  /** Called when it whistles (Phase 7 audio). */
  onCall: ((x: number, y: number, z: number) => void) | null = null;
  private readonly body: THREE.Mesh;
  private readonly wings: THREE.Mesh[];

  constructor() {
    const material = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.08 });
    const geometry = mergeGeometries([
      noUv(part(0.026, 0.024, 0.05, 0x1f8fb8, [0, 0.01, 0])), // back
      noUv(part(0.022, 0.02, 0.042, 0xe0702a, [0, -0.004, 0.004])), // orange breast
      noUv(part(0.022, 0.022, 0.024, 0x1a6f9c, [0, 0.022, 0.05])), // head
      noUv(part(0.008, 0.006, 0.01, 0xf2efe6, [0.016, 0.014, 0.058])), // white neck patch
      noUv(part(0.008, 0.006, 0.01, 0xf2efe6, [-0.016, 0.014, 0.058])),
      noUv(part(0.012, 0.004, 0.03, 0x1678a8, [0, 0.008, -0.06])), // tail
      beak(),
    ]);
    this.body = new THREE.Mesh(geometry, material);
    this.body.castShadow = false;
    this.group.add(this.body);
    const wingGeometry = noUv(part(0.042, 0.004, 0.024, 0x1b84b0, [0.04, 0, 0]));
    this.wings = [1, -1].map((side) => {
      const w = new THREE.Mesh(wingGeometry, material);
      w.scale.x = side;
      w.position.set(0.012 * side, 0.016, 0.004);
      this.body.add(w);
      return w;
    });
    // About life size, a touch larger so it reads at a distance.
    this.group.scale.setScalar(1.6);
    this.group.visible = false;
  }

  update(dt: number, world: KingfisherWorld, camera: THREE.Vector3): KingfisherEvents {
    const b = this.brain;
    const ev = b.step(Math.min(dt, 0.1), world, { x: camera.x, z: camera.z });
    this.group.visible = b.visible;
    if (!b.visible) return ev;
    this.group.position.set(b.x, b.y, b.z);
    this.group.rotation.set(0, b.yaw, 0);
    this.body.rotation.x = -b.pitch;
    const beat = Math.sin(b.wingPhase) * 0.9 * b.flap;
    const folded = (1 - b.flap) * 0.15;
    this.wings.forEach((w, k) => (w.rotation.z = (k === 0 ? 1 : -1) * (beat - folded)));
    if (ev.splash) this.onSplash?.(ev.splash.x, ev.splash.y, ev.splash.z);
    if (ev.call) this.onCall?.(b.x, b.y, b.z);
    return ev;
  }
}
