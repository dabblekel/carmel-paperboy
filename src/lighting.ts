import * as THREE from 'three';
import type { LightingReference } from './types';

/**
 * Browser lighting presets. Blender's area-light rig and world shader do not export, so each
 * preset rebuilds the look from ordinary three.js lights. Intensities start from the Blender
 * values (sun strength and area-light irradiance at the planet) and were then matched by eye
 * against Cycles reference renders; they are not expected to be numerically identical.
 */
export interface LightingPreset {
  background: string; // sRGB, shown untouched behind the world
  exposure: number;
  ambient: { color: [number, number, number]; intensity: number }; // uniform sky light (linear)
  sun: { color: [number, number, number]; intensity: number; shadowIntensity: number };
  fills: { direction: [number, number, number]; color: [number, number, number]; intensity: number }[];
}

export const PRESETS: Record<string, LightingPreset> = {
  sunny_warm: {
    background: '#7ea8d2',
    exposure: 1.46, // 2^0.55, Blender's exposure setting
    ambient: { color: [0.78, 0.84, 0.92], intensity: 0.45 },
    sun: { color: [1, 0.82, 0.59], intensity: 3.4, shadowIntensity: 0.9 },
    // Directions the light travels, from the Blender area lights (glTF axes).
    fills: [
      { direction: [0.3276, -0.7861, -0.5241], color: [1, 0.85, 0.65], intensity: 0.3 }, // V2 key
      { direction: [0.8193, -0.4916, -0.295], color: [1, 0.85, 0.65], intensity: 0.3 }, // cottage afternoon sun
      { direction: [-0.7439, -0.5667, -0.3542], color: [0.88, 0.94, 1], intensity: 0.2 }, // fill
      { direction: [0.0339, -0.6448, 0.7636], color: [1, 0.91, 0.78], intensity: 0.2 }, // rim
      { direction: [0.5449, 0.7785, 0.3114], color: [0.84, 0.9, 1], intensity: 0.25 }, // back fill
      { direction: [-0.4618, 0.5541, -0.6926], color: [1, 0.88, 0.7], intensity: 0.2 }, // south fill
    ],
  },
};

export function applyLighting(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  reference: LightingReference,
  worldRadius: number,
): THREE.Group {
  const preset = PRESETS[reference.preset] ?? PRESETS.sunny_warm;
  const rig = new THREE.Group();
  rig.name = 'viewer-lighting';

  renderer.toneMapping = THREE.AgXToneMapping; // Blender scene uses the AgX view transform
  renderer.toneMappingExposure = preset.exposure;
  scene.background = new THREE.Color(preset.background);

  const linear = (c: [number, number, number]) => new THREE.Color().setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace);

  // Soft uniform sky light, standing in for the world shader's ambient contribution.
  rig.add(new THREE.HemisphereLight(linear(preset.ambient.color), linear(preset.ambient.color), preset.ambient.intensity * Math.PI));

  const sunDir = new THREE.Vector3(...(reference.sunDirection ?? [0.44, -0.735, -0.515])).normalize();
  const sun = new THREE.DirectionalLight(linear(reference.sunColorLinear ?? preset.sun.color), preset.sun.intensity);
  sun.name = 'sun';
  sun.position.copy(sunDir).multiplyScalar(-worldRadius * 3);
  sun.target.position.set(0, 0, 0);
  sun.castShadow = true;
  const s = worldRadius * 1.35;
  Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: worldRadius, far: worldRadius * 5 });
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.035;
  sun.shadow.radius = 3;
  sun.shadow.intensity = preset.sun.shadowIntensity; // restrained shadows
  // Scenery and sun are static, so the shadow map is drawn once rather than every frame.
  // (Walking, step 4, will need the character's shadow refreshed separately.)
  sun.shadow.autoUpdate = false;
  sun.shadow.needsUpdate = true;
  rig.add(sun, sun.target);

  for (const fill of preset.fills) {
    const light = new THREE.DirectionalLight(linear(fill.color), fill.intensity);
    light.position.set(...fill.direction).normalize().multiplyScalar(-worldRadius * 3);
    rig.add(light);
  }
  scene.add(rig);
  return rig;
}
