import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Draw-call reduction for static scenery.
 *
 * Carmel has ~4,000 small meshes, so drawing them one by one costs ~6,000–10,000 draw calls a
 * frame (with shadows). This combines static meshes that share a material into chunks, one per
 * material per region of space, so the GPU draws a few hundred objects instead. Regions keep
 * frustum culling useful. The original meshes stay in the scene graph, hidden, with their names,
 * entity IDs and extras intact, so hover targets and collision data can still refer to them.
 */
export interface BatchResult {
  sourceMeshes: number;
  chunks: number;
  group: THREE.Group;
}

export function batchStaticMeshes(root: THREE.Object3D, keepSeparate: Set<THREE.Object3D>, cellSize = 12): BatchResult {
  root.updateMatrixWorld(true);
  const buckets = new Map<string, { material: THREE.Material; geometries: THREE.BufferGeometry[]; meshes: THREE.Mesh[] }>();
  const centre = new THREE.Vector3();
  let sourceMeshes = 0;

  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || (mesh as THREE.SkinnedMesh).isSkinnedMesh || keepSeparate.has(mesh)) return;
    if (Array.isArray(mesh.material) || !mesh.visible) return;
    const g = mesh.geometry;
    if (!g.attributes.position) return;
    // Merged geometries must share the same attribute layout.
    const attrs = Object.keys(g.attributes).sort().join(',');
    if (!g.boundingSphere) g.computeBoundingSphere();
    centre.copy(g.boundingSphere!.center).applyMatrix4(mesh.matrixWorld);
    const cell = [centre.x, centre.y, centre.z].map((c) => Math.floor(c / cellSize)).join(':');
    const key = `${mesh.material.uuid}|${attrs}|${g.index ? 'i' : 'n'}|${cell}`;
    let bucket = buckets.get(key);
    if (!bucket) buckets.set(key, (bucket = { material: mesh.material, geometries: [], meshes: [] }));
    const copy = g.clone();
    copy.applyMatrix4(mesh.matrixWorld);
    // Mirrored transforms flip triangle winding; restore it so faces are not culled.
    if (mesh.matrixWorld.determinant() < 0 && copy.index) {
      const idx = copy.index.array as Uint16Array | Uint32Array;
      for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];
    }
    copy.morphAttributes = {};
    bucket.geometries.push(copy);
    bucket.meshes.push(mesh);
  });

  const group = new THREE.Group();
  group.name = 'batched-static-scenery';
  for (const bucket of buckets.values()) {
    const merged = bucket.geometries.length === 1 ? bucket.geometries[0] : mergeGeometries(bucket.geometries, false);
    if (!merged) continue; // incompatible layout: leave the originals drawing themselves
    const chunk = new THREE.Mesh(merged, bucket.material);
    chunk.castShadow = chunk.receiveShadow = true;
    chunk.matrixAutoUpdate = false;
    chunk.userData.sourceMeshes = bucket.meshes.length;
    group.add(chunk);
    for (const m of bucket.meshes) m.visible = false;
    sourceMeshes += bucket.meshes.length;
    if (merged !== bucket.geometries[0]) bucket.geometries.forEach((g) => g.dispose());
  }
  return { sourceMeshes, chunks: group.children.length, group };
}
