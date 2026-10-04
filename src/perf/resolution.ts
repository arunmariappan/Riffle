/**
 * Dynamic resolution (plan D9, Phase 9): watches how long frames take on the GPU and lowers the render scale a step
 * when they run over budget, raising it again slowly when there is room, so the frame rate holds steady in heavy
 * views (a storm in the forest) without the picture swimming in and out of focus. Pure TypeScript.
 */

export interface ResolutionOptions {
  /** Frame time to hold, ms (60 fps = 16.7). */
  targetMs: number;
  min: number;
  max: number;
  /** How much one change moves the scale. */
  step: number;
  /** Seconds over budget before dropping, and with room before rising. */
  dropAfter: number;
  raiseAfter: number;
}

export const RESOLUTION_DEFAULTS: ResolutionOptions = {
  targetMs: 1000 / 60,
  min: 0.6,
  max: 0.85,
  step: 0.05,
  dropAfter: 0.6,
  raiseAfter: 4,
};

export class ResolutionController {
  scale: number;
  private average = -1;
  private over = 0;
  private under = 0;
  private readonly o: ResolutionOptions;

  constructor(options: Partial<ResolutionOptions> = {}) {
    this.o = { ...RESOLUTION_DEFAULTS, ...options };
    this.scale = this.o.max;
  }

  /** Changes the frame time to hold (the frame cap). */
  setTarget(ms: number): void {
    this.o.targetMs = ms;
  }

  /** Changes the bounds (a new quality preset); the scale is kept inside them. */
  setRange(min: number, max: number): void {
    this.o.min = min;
    this.o.max = max;
    this.scale = Math.min(max, Math.max(min, this.scale));
  }

  /**
   * Feeds one frame's time (ms; GPU time when known) over `dt` seconds. Returns the new scale when it changes, else
   * null.
   */
  update(frameMs: number, dt: number): number | null {
    if (!(frameMs > 0) || !(dt > 0)) return null;
    // A smoothed frame time, so one slow frame (a shader compiling) doesn't count.
    this.average = this.average < 0 ? frameMs : this.average + (frameMs - this.average) * Math.min(1, dt * 3);
    const t = this.o.targetMs;
    if (this.average > t * 1.08) {
      this.over += dt;
      this.under = 0;
    } else if (this.average < t * 0.78) {
      this.under += dt;
      this.over = 0;
    } else {
      this.over = 0;
      this.under = 0;
    }
    let next = this.scale;
    if (this.over >= this.o.dropAfter) {
      // Further over budget: a bigger step down (pixels scale with the square of the resolution).
      const ratio = this.average / t;
      next = this.scale * Math.max(1 / Math.sqrt(ratio), 1 - this.o.step * 2) - (ratio > 1.3 ? 0 : this.o.step * 0.5);
      next = Math.min(next, this.scale - this.o.step);
      this.over = 0;
    } else if (this.under >= this.o.raiseAfter) {
      next = this.scale + this.o.step;
      this.under = 0;
    }
    next = Math.round(Math.min(this.o.max, Math.max(this.o.min, next)) * 100) / 100;
    if (next === this.scale) return null;
    this.scale = next;
    // The new resolution changes the frame time: start measuring afresh.
    this.average = -1;
    return next;
  }
}
