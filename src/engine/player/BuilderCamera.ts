import * as THREE from 'three/webgpu';
import type { Input } from './Input';

export interface BuilderView {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  distance: number;
}

/**
 * The Builder camera (plan 4): an orbit around a point on the ground. Right-drag turns, middle-drag (or Shift +
 * right-drag) pans, the wheel zooms, WASD and the arrow keys pan, Q and E turn. It eases toward its goal so moves feel
 * smooth, and never dips under the terrain.
 */
export class BuilderCamera {
  /** Where the orbit is going (eased toward each frame). */
  readonly goal: BuilderView = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0.85, distance: 45 };
  private readonly current: BuilderView = { ...this.goal };
  private readonly element: HTMLElement;
  private readonly heightAt: (x: number, z: number) => number;
  private drag: { button: number; x: number; y: number; pan: boolean } | null = null;
  private readonly listeners: [EventTarget, string, EventListener][] = [];
  enabled = false;

  constructor(element: HTMLElement, heightAt: (x: number, z: number) => number) {
    this.element = element;
    this.heightAt = heightAt;
    this.on(element, 'pointerdown', (e) => {
      const pe = e as PointerEvent;
      if (!this.enabled || (pe.button !== 1 && pe.button !== 2)) return;
      this.drag = { button: pe.button, x: pe.clientX, y: pe.clientY, pan: pe.button === 1 || pe.shiftKey };
      element.setPointerCapture(pe.pointerId);
      pe.preventDefault();
    });
    this.on(element, 'pointermove', (e) => {
      const pe = e as PointerEvent;
      if (!this.drag) return;
      const dx = pe.clientX - this.drag.x;
      const dy = pe.clientY - this.drag.y;
      this.drag.x = pe.clientX;
      this.drag.y = pe.clientY;
      // Grab the ground: it follows the cursor.
      if (this.drag.pan) this.pan(-dx, dy, this.goal.distance * 0.0016);
      else {
        this.goal.yaw -= dx * 0.005;
        this.goal.pitch = THREE.MathUtils.clamp(this.goal.pitch + dy * 0.004, 0.12, 1.5);
      }
    });
    const end = (e: Event) => {
      if (!this.drag) return;
      this.drag = null;
      const pe = e as PointerEvent;
      if (element.hasPointerCapture(pe.pointerId)) element.releasePointerCapture(pe.pointerId);
    };
    this.on(element, 'pointerup', end);
    this.on(element, 'pointercancel', end);
    this.on(element, 'contextmenu', (e) => {
      if (this.enabled) e.preventDefault();
    });
  }

  private on(target: EventTarget, type: string, fn: EventListener): void {
    target.addEventListener(type, fn);
    this.listeners.push([target, type, fn]);
  }

  /** Pans the goal in screen directions (right, forward on the ground). */
  pan(right: number, forward: number, scale: number): void {
    const cy = Math.cos(this.goal.yaw);
    const sy = Math.sin(this.goal.yaw);
    // Camera looks toward −(sin yaw, cos yaw); screen right is (cos yaw, −sin yaw).
    this.goal.x += (cy * right - sy * forward) * scale;
    this.goal.z += (-sy * right - cy * forward) * scale;
  }

  zoom(steps: number): void {
    this.goal.distance = THREE.MathUtils.clamp(this.goal.distance * Math.pow(1.15, steps), 3, 700);
  }

  /** Jumps (or eases, when `smooth`) to look at a point. */
  frame(x: number, z: number, options: Partial<BuilderView> = {}, smooth = false): void {
    Object.assign(this.goal, { x, z, ...options });
    this.goal.y = this.heightAt(x, z);
    if (!smooth) Object.assign(this.current, this.goal);
  }

  view(): BuilderView {
    return { ...this.goal };
  }

  update(dt: number, input: Input, camera: THREE.PerspectiveCamera, takeWheel: boolean): void {
    if (takeWheel) {
      const w = input.takeWheel();
      if (w !== 0) this.zoom(w);
    }
    const fast = input.pressed('ShiftLeft', 'ShiftRight') ? 2.5 : 1;
    const speed = this.goal.distance * 0.9 * fast * dt;
    let right = 0;
    let forward = 0;
    if (input.pressed('KeyW', 'ArrowUp')) forward += 1;
    if (input.pressed('KeyS', 'ArrowDown')) forward -= 1;
    if (input.pressed('KeyD', 'ArrowRight')) right += 1;
    if (input.pressed('KeyA', 'ArrowLeft')) right -= 1;
    if (right || forward) this.pan(right, forward, speed);
    if (input.pressed('KeyQ')) this.goal.yaw += dt * 1.2;
    if (input.pressed('KeyE')) this.goal.yaw -= dt * 1.2;
    this.goal.y = this.heightAt(this.goal.x, this.goal.z);

    const k = 1 - Math.exp(-dt * 10);
    const c = this.current;
    c.x += (this.goal.x - c.x) * k;
    c.y += (this.goal.y - c.y) * k;
    c.z += (this.goal.z - c.z) * k;
    let dyaw = this.goal.yaw - c.yaw;
    while (dyaw > Math.PI) dyaw -= Math.PI * 2;
    while (dyaw < -Math.PI) dyaw += Math.PI * 2;
    c.yaw += dyaw * k;
    c.pitch += (this.goal.pitch - c.pitch) * k;
    c.distance += (this.goal.distance - c.distance) * k;

    const horizontal = Math.cos(c.pitch) * c.distance;
    const px = c.x + Math.sin(c.yaw) * horizontal;
    const pz = c.z + Math.cos(c.yaw) * horizontal;
    let py = c.y + Math.sin(c.pitch) * c.distance;
    py = Math.max(py, this.heightAt(px, pz) + 1.5);
    camera.position.set(px, py, pz);
    camera.lookAt(c.x, c.y, c.z);
  }

  dispose(): void {
    for (const [t, type, fn] of this.listeners) t.removeEventListener(type, fn);
  }
}
