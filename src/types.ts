// Shape of public/models/<id>/manifest.json (written by the Blender export script).
export type Vec3 = [number, number, number];

export interface Viewpoint {
  id: string;
  label: string;
  position: Vec3;
  target: Vec3;
  /** Camera up from the source camera. The viewer orbits around the local ground normal instead. */
  up?: Vec3;
  /** Field of view across the larger screen dimension, as in Blender's Auto sensor fit. */
  fovDegrees?: number;
  sourceCamera?: string;
  /** Blender presentation cameras are orthographic; orthoScale is the view width in metres. */
  projection?: 'perspective' | 'orthographic';
  orthoScale?: number | null;
}

export interface Landmark {
  id: string;
  label: string;
  node: string;
  targetNode: string;
  position: Vec3;
  up?: Vec3;
}

export interface LightingReference {
  preset: string;
  skyColorLinear: Vec3;
  sunColorLinear: Vec3;
  sourceSunEnergy: number;
  sourceExposure: number;
  sunDirection: Vec3 | null;
}

export interface Manifest {
  schemaVersion: number;
  id: string;
  title: string;
  asset: string;
  movement: { type: 'spherical' | 'flat'; center: Vec3; nominalRadius?: number };
  spawn: { node: string; position: Vec3; rotation: [number, number, number, number]; forward: Vec3; up: Vec3 };
  character: { node: string; rig: string; clips: { name: string; durationSeconds: number; loop?: boolean }[] };
  lighting: LightingReference;
  landmarks: Landmark[];
  viewpoints?: Viewpoint[];
}

export interface ModelIndex {
  default: string;
  models: { id: string; title: string; manifest: string }[];
}
