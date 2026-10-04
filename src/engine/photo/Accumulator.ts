import * as THREE from 'three/webgpu';
import { float, mix, screenUV, texture, uniform, vec4 } from 'three/tsl';
import { unpadRows } from '../../photo/pixels';

/**
 * Averages rendered frames (plan 6.10: accumulation). Each frame the pipeline renders into a sample target; a
 * full-screen pass blends it into a running average (ping-pong between two half-float targets), which can be shown on
 * screen while it develops and read back as 8-bit RGBA. Values are the pipeline's display output (tone-mapped), so
 * the copies below must not convert colors again.
 */
export class Accumulator {
  readonly width: number;
  readonly height: number;
  readonly sample: THREE.RenderTarget;
  private readonly acc: [THREE.RenderTarget, THREE.RenderTarget];
  private readonly out: THREE.RenderTarget;
  private readonly weight: any = uniform(1);
  private readonly prevNode: any;
  private readonly sampleNode: any;
  private readonly copyNode: any;
  private readonly blend: THREE.QuadMesh;
  private readonly copy: THREE.QuadMesh;
  private current = 0;
  count = 0;

  constructor(
    private readonly renderer: THREE.WebGPURenderer,
    width: number,
    height: number,
  ) {
    this.width = width;
    this.height = height;
    const opts = { type: THREE.HalfFloatType, depthBuffer: false };
    this.sample = new THREE.RenderTarget(width, height, { type: THREE.HalfFloatType });
    this.acc = [new THREE.RenderTarget(width, height, opts), new THREE.RenderTarget(width, height, opts)];
    this.out = new THREE.RenderTarget(width, height, { type: THREE.UnsignedByteType, depthBuffer: false });
    this.prevNode = texture(this.acc[0].texture, screenUV);
    this.sampleNode = texture(this.sample.texture, screenUV);
    const blendMat = new THREE.MeshBasicNodeMaterial();
    blendMat.colorNode = vec4(mix(this.prevNode.rgb, this.sampleNode.rgb, this.weight as any) as any, float(1));
    this.blend = new THREE.QuadMesh(blendMat);
    this.copyNode = texture(this.acc[0].texture, screenUV);
    const copyMat = new THREE.MeshBasicNodeMaterial();
    copyMat.colorNode = vec4(this.copyNode.rgb, float(1));
    this.copy = new THREE.QuadMesh(copyMat);
  }

  /** Renders straight (no tone mapping or color conversion) while `fn` runs. */
  private raw(fn: () => void): void {
    const r = this.renderer;
    const tone = r.toneMapping;
    const space = r.outputColorSpace;
    r.toneMapping = THREE.NoToneMapping;
    r.outputColorSpace = THREE.LinearSRGBColorSpace;
    try {
      fn();
    } finally {
      r.toneMapping = tone;
      r.outputColorSpace = space;
    }
  }

  /** Renders one frame with `render` (into the sample target) and folds it into the average. */
  add(render: () => void): void {
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    r.setRenderTarget(this.sample);
    render();
    const from = this.acc[this.current] as THREE.RenderTarget;
    const to = this.acc[1 - this.current] as THREE.RenderTarget;
    this.prevNode.value = from.texture;
    this.weight.value = 1 / (this.count + 1);
    this.raw(() => {
      r.setRenderTarget(to);
      this.blend.render(r);
    });
    this.current = 1 - this.current;
    this.count++;
    r.setRenderTarget(prevTarget);
  }

  /** Shows the average so far on screen (the photo developing). */
  show(): void {
    const r = this.renderer;
    this.copyNode.value = (this.acc[this.current] as THREE.RenderTarget).texture;
    this.raw(() => {
      r.setRenderTarget(null);
      this.copy.render(r);
    });
  }

  /** The average as tightly packed 8-bit RGBA rows, top row first. */
  async read(): Promise<Uint8Array> {
    const r = this.renderer;
    this.copyNode.value = (this.acc[this.current] as THREE.RenderTarget).texture;
    this.raw(() => {
      r.setRenderTarget(this.out);
      this.copy.render(r);
    });
    r.setRenderTarget(null);
    const data = (await r.readRenderTargetPixelsAsync(this.out, 0, 0, this.width, this.height)) as Uint8Array;
    return unpadRows(data, this.width, this.height, 4);
  }

  /** Starts a new average. */
  reset(): void {
    this.count = 0;
  }

  dispose(): void {
    this.sample.dispose();
    for (const t of this.acc) t.dispose();
    this.out.dispose();
  }
}
