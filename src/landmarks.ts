import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

// Fast raycasts on large merged meshes (bounding-volume hierarchy per chunk).
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

declare module 'three' {
  interface BufferGeometry {
    computeBoundsTree: typeof computeBoundsTree;
    disposeBoundsTree: typeof disposeBoundsTree;
  }
}

export interface HoverTarget {
  id: string;
  /** Invisible box around the whole landmark, in the landmark's own frame. */
  box: THREE.Mesh;
  /** Point to anchor a pinned card to (top centre of the box, world space). */
  anchor: THREE.Vector3;
  /** The landmark's own meshes (hidden originals of the merged scenery). */
  parts: THREE.Mesh[];
  /** The front door, when the model has one (world space). */
  door?: Door;
}

export interface Door {
  /** Middle of the door at ground level. */
  base: THREE.Vector3;
  /** Middle of the door's top edge. */
  top: THREE.Vector3;
  /** Unit direction out of the door, along the ground. */
  out: THREE.Vector3;
  /** Half the width of the doorway (m). */
  halfWidth: number;
  /** How far out from the door he can get (steps or a porch may keep him back); set once walking is ready. */
  standoff: number;
}

/** Door meshes by name, best match first: the door itself, a double door's divider, a booth's panels. */
const DOOR_NAMES = [/^door(\.\d+)?$/i, /^entry divider/i, /door panel/i, /door(?!.*(handle|surround|canopy))/i];

function findDoor(entity: THREE.Object3D): Door | undefined {
  const meshes: THREE.Mesh[] = [];
  entity.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
  const nameOf = (m: THREE.Object3D) => String(m.userData?.name ?? m.name);
  let found: THREE.Mesh[] = [];
  for (const re of DOOR_NAMES) {
    found = meshes.filter((m) => re.test(nameOf(m)));
    if (found.length) break;
  }
  if (!found.length) return undefined;
  // The doorway's extent in the building's own frame (+Y up, +Z out of the front).
  entity.updateMatrixWorld(true);
  const toLocal = new THREE.Matrix4().copy(entity.matrixWorld).invert();
  const box = new THREE.Box3();
  const m = new THREE.Matrix4();
  for (const mesh of found) {
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    box.union(mesh.geometry.boundingBox!.clone().applyMatrix4(m.multiplyMatrices(toLocal, mesh.matrixWorld)));
  }
  const cx = (box.min.x + box.max.x) / 2;
  const front = box.max.z;
  const base = new THREE.Vector3(cx, box.min.y, front).applyMatrix4(entity.matrixWorld);
  // (at least 1.6 m up: a phone booth's "door" is only its lower panels)
  const top = new THREE.Vector3(cx, Math.max(box.max.y, box.min.y + 1.6), front).applyMatrix4(entity.matrixWorld);
  const up = top.clone().sub(base).normalize();
  const out = new THREE.Vector3(0, 0, 1).transformDirection(entity.matrixWorld);
  out.addScaledVector(up, -out.dot(up)).normalize();
  return { base, top, out, halfWidth: Math.max(0.45, (box.max.x - box.min.x) / 2), standoff: 0 };
}

/**
 * Hover targets are simple boxes around whole landmarks, built from the bounds the Blender
 * export stored on each `target_<id>` node. They are separate from what is drawn and from
 * movement collision. A hit only counts when the first visible surface under the pointer lies
 * inside that landmark's box, so buildings hidden behind others (or a tree in front) don't trigger.
 */
export class LandmarkPicker {
  readonly targets: HoverTarget[] = [];
  private raycaster = new THREE.Raycaster();
  private occluders: THREE.Object3D[];
  private invWorld = new THREE.Matrix4();
  private local = new THREE.Vector3();

  constructor(world: THREE.Object3D, ids: string[], occluders: THREE.Object3D[]) {
    this.occluders = occluders;
    this.raycaster.firstHitOnly = true;
    const material = new THREE.MeshBasicMaterial({ visible: false });
    for (const id of ids) {
      const marker = world.getObjectByName(`target_${id}`);
      const entity = marker?.parent;
      const ex = marker?.userData as { source_bounds_min?: number[]; source_bounds_max?: number[] } | undefined;
      if (!entity || !ex?.source_bounds_min || !ex.source_bounds_max) {
        console.warn(`[guide] No hover bounds for “${id}”; it will have no tooltip.`);
        continue;
      }
      const [x0, y0, z0] = ex.source_bounds_min;
      const [x1, y1, z1] = ex.source_bounds_max;
      // Blender (x, y, z) -> glTF (x, z, -y). Clamp the bottom near the ground: a few landmarks
      // contain small parts that reach deep into the planet.
      const min = new THREE.Vector3(x0, Math.max(z0, -0.3), -y1);
      const max = new THREE.Vector3(x1, z1, -y0);
      const size = max.clone().sub(min);
      const box = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), material);
      box.name = `hover_${id}`;
      box.position.copy(min.clone().add(max).multiplyScalar(0.5));
      box.userData.landmarkId = id;
      entity.add(box);
      box.updateMatrixWorld(true);
      const anchor = new THREE.Vector3(0, size.y / 2, 0).applyMatrix4(box.matrixWorld);
      // The landmark's own (hidden, unmerged) meshes, used to tell touching landmarks apart.
      const parts: THREE.Mesh[] = [];
      entity.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && m !== box) parts.push(m);
      });
      const door = findDoor(entity);
      if (!door) console.warn(`[guide] No door found for “${id}”; its card shows near the building.`);
      this.targets.push({ id, box, anchor, parts, door });
    }
  }

  private prepared = false;
  /** Search trees for pointer picking, built on first use (walking never needs them). */
  private prepare(): void {
    if (this.prepared) return;
    this.prepared = true;
    const build = (m: THREE.Object3D) => {
      const mesh = m as THREE.Mesh;
      if (mesh.isMesh && !mesh.geometry.boundsTree) mesh.geometry.computeBoundsTree();
    };
    for (const o of this.occluders) o.traverse(build);
    for (const t of this.targets) t.parts.forEach(build);
  }

  /** The landmark under the pointer (normalised device coords), or null. */
  pick(ndc: THREE.Vector2, camera: THREE.Camera): string | null {
    this.prepare();
    this.raycaster.setFromCamera(ndc, camera);
    const surface = this.raycaster.intersectObjects(this.occluders, true)[0];
    if (!surface) return null;
    // Candidate landmarks: boxes containing the first visible surface (boxes are small and few).
    const candidates = this.targets.filter((t) => {
      this.invWorld.copy(t.box.matrixWorld).invert();
      this.local.copy(surface.point).applyMatrix4(this.invWorld);
      const p = (t.box.geometry as THREE.BoxGeometry).parameters;
      const pad = 0.05;
      return Math.abs(this.local.x) <= p.width / 2 + pad && Math.abs(this.local.y) <= p.height / 2 + pad &&
        Math.abs(this.local.z) <= p.depth / 2 + pad;
    });
    if (candidates.length === 0) return null;
    // Exact owner: the landmark whose own geometry is the surface that was hit. Anything else
    // inside the box (a tree, the path, a neighbour's wall) still counts as that landmark, so
    // pointing at its doorstep works, unless it belongs to another candidate landmark.
    let fallback: string | null = null;
    for (const t of candidates) {
      const own = this.raycaster.intersectObjects(t.parts, false)[0];
      if (own && Math.abs(own.distance - surface.distance) < 0.02) return t.id;
      fallback ??= t.id;
    }
    return candidates.length === 1 ? fallback : null;
  }
}
