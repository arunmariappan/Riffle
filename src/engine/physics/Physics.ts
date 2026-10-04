import RAPIER from '@dimforge/rapier3d-compat';
import type { Heightfield } from '../../sim/terrain/heightfield';
import { downsample } from '../../sim/terrain/heightfield';

let initPromise: Promise<void> | null = null;

export function initRapier(): Promise<void> {
  initPromise ??= RAPIER.init();
  return initPromise;
}

/**
 * Rapier physics (plan D17): the terrain as a heightfield at 1 m resolution (plan fix: the full render grid would be
 * too heavy), stones as dynamic bodies that settle and freeze, and the player's kinematic capsule.
 */
export class Physics {
  readonly rapier = RAPIER;
  readonly world: RAPIER.World;
  readonly terrain: RAPIER.Collider;
  private accumulator = 0;
  private readonly fixedDt = 1 / 60;

  private constructor(world: RAPIER.World, terrain: RAPIER.Collider) {
    this.world = world;
    this.terrain = terrain;
  }

  static async create(hf: Heightfield): Promise<Physics> {
    await initRapier();
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const coarse = hf.cell < 1 ? downsample(hf, Math.round(1 / hf.cell)) : hf;
    const n = coarse.size - 1;
    // Rapier wants column-major heights: column = x, row = z.
    const heights = new Float32Array(coarse.size * coarse.size);
    for (let x = 0; x < coarse.size; x++) {
      for (let z = 0; z < coarse.size; z++) {
        heights[x * coarse.size + z] = coarse.heights[z * coarse.size + x] as number;
      }
    }
    const extent = n * coarse.cell;
    const desc = RAPIER.ColliderDesc.heightfield(n, n, heights, { x: extent, y: 1, z: extent });
    desc.setTranslation(coarse.originX + extent / 2, 0, coarse.originZ + extent / 2);
    desc.setFriction(0.9);
    const terrain = world.createCollider(desc);
    // Scene queries (raycasts) only see colliders after a step.
    world.step();
    return new Physics(world, terrain);
  }

  /** Fixed-step simulation; returns the number of steps taken. */
  step(dt: number): number {
    this.accumulator += Math.min(dt, 0.1);
    let steps = 0;
    while (this.accumulator >= this.fixedDt && steps < 4) {
      this.world.timestep = this.fixedDt;
      this.world.step();
      this.accumulator -= this.fixedDt;
      steps++;
    }
    return steps;
  }

  /** A convex hull for a rock: the unit rock's vertices scaled to the stone's radius and height. */
  private stoneShape(points: Float32Array, radius: number, height: number): RAPIER.ColliderDesc | null {
    const scaled = new Float32Array(points.length);
    for (let i = 0; i < points.length; i += 3) {
      scaled[i] = (points[i] as number) * radius;
      scaled[i + 1] = (points[i + 1] as number) * height;
      scaled[i + 2] = (points[i + 2] as number) * radius;
    }
    return RAPIER.ColliderDesc.convexHull(scaled) ?? RAPIER.ColliderDesc.ball(Math.max(radius, height) * 0.8);
  }

  /** A stone that falls and settles with physics (builder drops, plan 6.8). Density in t/m³. */
  dropStone(
    points: Float32Array,
    radius: number,
    height: number,
    position: { x: number; y: number; z: number },
    rotation: { x: number; y: number; z: number; w: number },
    density = 2.6,
  ): RAPIER.RigidBody {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(position.x, position.y, position.z)
        .setRotation(rotation)
        .setCcdEnabled(true),
    );
    const shape = this.stoneShape(points, radius, height);
    if (shape) this.world.createCollider(shape.setDensity(density).setFriction(0.8).setRestitution(0.1), body);
    return body;
  }

  /** Freezes a settled stone in place so later stones can land on it. */
  freeze(body: RAPIER.RigidBody): void {
    body.setBodyType(RAPIER.RigidBodyType.Fixed, false);
  }

  /** A fixed collider for a stone that is already in place (so dropped stones land on it). */
  addFixedStone(
    points: Float32Array,
    radius: number,
    height: number,
    position: { x: number; y: number; z: number },
    rotation: { x: number; y: number; z: number; w: number },
  ): RAPIER.RigidBody {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(position.x, position.y, position.z).setRotation(rotation),
    );
    const shape = this.stoneShape(points, radius, height);
    if (shape) this.world.createCollider(shape.setFriction(0.8), body);
    return body;
  }

  removeBody(body: RAPIER.RigidBody): void {
    this.world.removeRigidBody(body);
  }

  /** Casts a ray straight down and returns the hit height, or null. */
  groundHeight(x: number, z: number, fromY = 2000): number | null {
    const ray = new RAPIER.Ray({ x, y: fromY, z }, { x: 0, y: -1, z: 0 });
    const hit = this.world.castRay(ray, fromY + 1000, true);
    return hit ? fromY - hit.timeOfImpact : null;
  }

  dispose(): void {
    this.world.free();
  }
}
