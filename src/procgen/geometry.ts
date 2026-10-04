import * as THREE from 'three/webgpu';

/** Small helper for building indexed geometry with optional extra float attributes. */
export class GeometryBuilder {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly uvs: number[] = [];
  readonly indices: number[] = [];
  private readonly extras = new Map<string, { size: number; data: number[] }>();

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  defineAttribute(name: string, size: number): void {
    if (!this.extras.has(name)) this.extras.set(name, { size, data: [] });
  }

  vertex(
    p: THREE.Vector3,
    n: THREE.Vector3,
    u: number,
    v: number,
    extra: Record<string, number | readonly number[]> = {},
  ): number {
    this.positions.push(p.x, p.y, p.z);
    this.normals.push(n.x, n.y, n.z);
    this.uvs.push(u, v);
    for (const [name, attr] of this.extras) {
      const value = extra[name];
      if (value === undefined) for (let k = 0; k < attr.size; k++) attr.data.push(0);
      else if (typeof value === 'number') attr.data.push(value);
      else for (let k = 0; k < attr.size; k++) attr.data.push(value[k] ?? 0);
    }
    return this.vertexCount - 1;
  }

  triangle(a: number, b: number, c: number): void {
    this.indices.push(a, b, c);
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.indices.push(a, b, c, a, c, d);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    for (const [name, attr] of this.extras)
      g.setAttribute(name, new THREE.Float32BufferAttribute(attr.data, attr.size));
    g.setIndex(
      this.vertexCount > 65535
        ? new THREE.Uint32BufferAttribute(this.indices, 1)
        : new THREE.Uint16BufferAttribute(this.indices, 1),
    );
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

/** Adds per-instance attributes used by the plant wind shader: aInst = (yaw, scale, phase, stiffness), aInstB = (x, z, height, radius). */
export function setPlantInstanceAttributes(
  geometry: THREE.BufferGeometry,
  instances: readonly { x: number; z: number; yaw: number; scale: number; phase: number; stiffness: number }[],
  height: number,
  radius: number,
): void {
  const a = new Float32Array(instances.length * 4);
  const b = new Float32Array(instances.length * 4);
  instances.forEach((inst, i) => {
    a.set([inst.yaw, inst.scale, inst.phase, inst.stiffness], i * 4);
    b.set([inst.x, inst.z, height, radius], i * 4);
  });
  geometry.setAttribute('aInst', new THREE.InstancedBufferAttribute(a, 4));
  geometry.setAttribute('aInstB', new THREE.InstancedBufferAttribute(b, 4));
}
