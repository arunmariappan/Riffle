import * as THREE from 'three/webgpu';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { Physics } from '../physics/Physics';
import type { Input } from './Input';

export interface WaterQuery {
  /** Water surface height at (x, z), or null when there's no water here. */
  surfaceAt(x: number, z: number): number | null;
  /** Current velocity at (x, z) (m/s), for the push you feel when wading or swimming. */
  currentAt(x: number, z: number): [number, number];
}

export interface PlayerSettings {
  fov: number;
  mouseSensitivity: number;
  headBob: boolean;
}

const EYE = 1.62;
const RADIUS = 0.3;
const HALF_HEIGHT = 0.6;

/**
 * First-person Explore mode (plan 4): walk, run and jump on a kinematic capsule; wade (the current pushes you,
 * deeper water slows you) and swim with no breath limit.
 */
export class ExplorePlayer {
  readonly position = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  settings: PlayerSettings = { fov: 68, mouseSensitivity: 0.0022, headBob: false };
  /** Mouse up looks down (comfort setting). */
  invertY = false;
  /** 0 on land, 0..1 wading depth fraction, >1 swimming. */
  waterDepth = 0;
  swimming = false;
  /** Camera is below the water surface. */
  underwater = false;
  speed = 0;

  private readonly physics: Physics;
  private readonly body: RAPIER.RigidBody;
  private readonly collider: RAPIER.Collider;
  private readonly controller: RAPIER.KinematicCharacterController;
  private verticalVelocity = 0;
  private grounded = false;
  private bobPhase = 0;
  private water: WaterQuery | null = null;
  private readonly push = new THREE.Vector2();

  constructor(physics: Physics, start: THREE.Vector3) {
    this.physics = physics;
    const R = physics.rapier;
    this.body = physics.world.createRigidBody(
      R.RigidBodyDesc.kinematicPositionBased().setTranslation(start.x, start.y + HALF_HEIGHT + RADIUS, start.z),
    );
    this.collider = physics.world.createCollider(R.ColliderDesc.capsule(HALF_HEIGHT, RADIUS), this.body);
    this.controller = physics.world.createCharacterController(0.02);
    this.controller.enableAutostep(0.45, 0.2, false);
    this.controller.enableSnapToGround(0.5);
    this.controller.setMaxSlopeClimbAngle((52 * Math.PI) / 180);
    this.controller.setMinSlopeSlideAngle((62 * Math.PI) / 180);
    this.controller.setApplyImpulsesToDynamicBodies(true);
    this.position.copy(start);
  }

  /** Standing on the ground (footsteps). */
  get onGround(): boolean {
    return this.grounded;
  }

  setWater(water: WaterQuery | null): void {
    this.water = water;
  }

  teleport(x: number, y: number, z: number, yaw?: number): void {
    this.body.setNextKinematicTranslation({ x, y: y + HALF_HEIGHT + RADIUS + 0.05, z });
    this.body.setTranslation({ x, y: y + HALF_HEIGHT + RADIUS + 0.05, z }, true);
    this.verticalVelocity = 0;
    if (yaw !== undefined) this.yaw = yaw;
  }

  update(dt: number, input: Input, camera: THREE.PerspectiveCamera): void {
    const [mx, my] = input.takeMouse();
    this.yaw -= mx * this.settings.mouseSensitivity;
    const dy = this.invertY ? -my : my;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * this.settings.mouseSensitivity, -1.45, 1.45);

    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(-forward.z, 0, forward.x);
    const move = new THREE.Vector3();
    if (input.pressed('KeyW', 'ArrowUp')) move.add(forward);
    if (input.pressed('KeyS', 'ArrowDown')) move.sub(forward);
    if (input.pressed('KeyD', 'ArrowRight')) move.add(right);
    if (input.pressed('KeyA', 'ArrowLeft')) move.sub(right);
    if (move.lengthSq() > 0) move.normalize();

    const feet = this.body.translation();
    const feetY = feet.y - HALF_HEIGHT - RADIUS;
    const surface = this.water?.surfaceAt(feet.x, feet.z) ?? null;
    const depth = surface === null ? 0 : Math.max(0, surface - feetY);
    this.waterDepth = depth;
    this.swimming = depth > 1.25;

    const run = input.pressed('ShiftLeft', 'ShiftRight');
    let speed = run ? 4.2 : 1.6;
    // Wading: deeper water slows you down.
    if (depth > 0.15 && !this.swimming) speed *= THREE.MathUtils.lerp(1, 0.4, Math.min(1, depth / 1.2));
    if (this.swimming) speed = run ? 1.6 : 1.0;
    const delta = move.multiplyScalar(speed * dt);

    // The current pushes you while wading or swimming.
    if (this.water && depth > 0.2) {
      const [cx, cz] = this.water.currentAt(feet.x, feet.z);
      const strength = this.swimming ? 0.55 : THREE.MathUtils.clamp(depth / 1.2, 0, 1) * 0.35;
      this.push.lerp(new THREE.Vector2(cx * strength, cz * strength), Math.min(1, dt * 2));
      delta.x += this.push.x * dt;
      delta.z += this.push.y * dt;
    } else {
      this.push.multiplyScalar(0.9);
    }

    if (this.swimming) {
      // Swimming: look up/down to dive or rise; Space rises, C sinks; gentle buoyancy toward the surface.
      const pitchMove = Math.sin(this.pitch) * (move.lengthSq() > 0 ? speed : 0);
      let vertical = pitchMove;
      if (input.pressed('Space')) vertical += 1.2;
      if (input.pressed('KeyC', 'ControlLeft')) vertical -= 1.2;
      const targetFeet = (surface as number) - 1.45;
      if (!input.pressed('KeyC', 'ControlLeft') && pitchMove >= 0) vertical += (targetFeet - feetY) * 0.6;
      this.verticalVelocity = vertical;
      delta.y = vertical * dt;
    } else {
      if (this.grounded && input.pressed('Space') && depth < 0.8) this.verticalVelocity = 4.2;
      this.verticalVelocity -= 9.81 * dt * (depth > 0.5 ? 0.6 : 1);
      if (this.grounded && this.verticalVelocity < 0) this.verticalVelocity = -1;
      delta.y = this.verticalVelocity * dt;
    }

    this.controller.computeColliderMovement(this.collider, delta);
    const corrected = this.controller.computedMovement();
    this.grounded = this.controller.computedGrounded();
    const next = { x: feet.x + corrected.x, y: feet.y + corrected.y, z: feet.z + corrected.z };
    this.body.setNextKinematicTranslation(next);
    this.speed = Math.hypot(corrected.x, corrected.z) / Math.max(dt, 1e-4);

    // Camera.
    const eyeY = next.y - HALF_HEIGHT - RADIUS + EYE;
    let bob = 0;
    if (this.settings.headBob && this.grounded && this.speed > 0.3) {
      this.bobPhase += dt * this.speed * 2.2;
      bob = Math.sin(this.bobPhase) * 0.035;
    }
    this.position.set(next.x, next.y - HALF_HEIGHT - RADIUS, next.z);
    camera.position.set(next.x, eyeY + bob, next.z);
    camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    if (camera.fov !== this.settings.fov) {
      camera.fov = this.settings.fov;
      camera.updateProjectionMatrix();
    }
    this.underwater = surface !== null && camera.position.y < surface - 0.02;
  }

  dispose(): void {
    this.physics.world.removeCharacterController(this.controller);
    this.physics.world.removeRigidBody(this.body);
  }
}
