import * as THREE from 'three/webgpu';
import { Tree } from '@dgreenheck/ez-tree';

export interface TreeSpecies {
  id: string;
  /** EZ-Tree preset to start from. */
  preset: string;
  /** Target height in meters (EZ-Tree presets are in their own units). */
  height: number;
  barkTint: number;
  leafTint: number;
  /** Optional option overrides applied after the preset. */
  tweak?: (options: any) => void;
}

export interface TreeGeometry {
  branches: THREE.BufferGeometry;
  leaves: THREE.BufferGeometry;
  barkMap: THREE.Texture | null;
  barkNormal: THREE.Texture | null;
  leafMap: THREE.Texture | null;
  height: number;
  radius: number;
}

/**
 * Generates one tree variation with EZ-Tree (plan D16) and returns its geometry scaled to the species height.
 * EZ-Tree's own materials use a WebGL-only shader hook, so we only keep the geometry and textures; the engine
 * builds WebGPU node materials with our wind shader.
 */
export function generateTree(species: TreeSpecies, seed: number): TreeGeometry {
  const tree = new Tree();
  tree.loadPreset(species.preset);
  tree.options.seed = seed;
  tree.options.bark.tint = species.barkTint;
  tree.options.leaves.tint = species.leafTint;
  species.tweak?.(tree.options);
  tree.generate();

  const branches = tree.branchesMesh.geometry.clone();
  const leaves = tree.leavesMesh.geometry.clone();
  branches.computeBoundingBox();
  leaves.computeBoundingBox();
  const box = new THREE.Box3().copy(branches.boundingBox!).union(leaves.boundingBox!);
  const rawHeight = Math.max(0.01, box.max.y - box.min.y);
  const scale = species.height / rawHeight;
  branches.scale(scale, scale, scale);
  leaves.scale(scale, scale, scale);
  branches.translate(0, -box.min.y * scale, 0);
  leaves.translate(0, -box.min.y * scale, 0);
  branches.computeBoundingSphere();
  leaves.computeBoundingSphere();
  leaves.computeVertexNormals();

  const barkMaterial = tree.branchesMesh.material as THREE.MeshPhongMaterial;
  const leafMaterial = tree.leavesMesh.material as THREE.MeshPhongMaterial;
  const radius = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) * 0.5 * scale;
  const result: TreeGeometry = {
    branches,
    leaves,
    barkMap: barkMaterial.map ?? null,
    barkNormal: barkMaterial.normalMap ?? null,
    leafMap: leafMaterial.map ?? null,
    height: species.height,
    radius,
  };
  tree.branchesMesh.geometry.dispose();
  tree.leavesMesh.geometry.dispose();
  return result;
}
