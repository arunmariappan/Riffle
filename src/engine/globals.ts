import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';

/** Uniforms shared by many materials (time, sun light for caustics, season). Updated once per frame by the World. */
export const globals = {
  /** Real time in seconds (animation). */
  time: uniform(0),
  /** Direct sun strength 0..1 (caustics, glints). */
  sunLight: uniform(1),
  sunColor: uniform(new THREE.Color(1, 0.97, 0.9)),
  /** Unit vector toward the sun (backlit fins and leaves). */
  sunDirection: uniform(new THREE.Vector3(0.3, 0.8, 0.2).normalize()),
  /** 0..1 how hard it rains now (rings on the water). */
  rain: uniform(0),
  /** 0..1 how wet the ground and stones are after rain (darker, glossier). */
  wetness: uniform(0),
  /** The player's feet (grass bends away). */
  player: uniform(new THREE.Vector3(0, -1000, 0)),
};
