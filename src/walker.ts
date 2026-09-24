import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GenerateMeshBVHWorker } from 'three-mesh-bvh/worker';
import type { Manifest } from './types';

/**
 * Walking on the spherical planet, ported from the Blender walk controller (carmel_walk.py):
 * the same ground surfaces, obstacle rules, ledge limit, ocean edge, speeds and follow camera.
 *
 * Differences requested for the browser:
 *  - Arrow keys / WASD move in screen directions (↑ away from the camera, ↓ towards it,
 *    ← → sideways). The paperboy turns to face where he walks; the camera does not spin.
 *  - Moving the cursor towards the left or right edge gently turns the view.
 *  - Space or C swings the camera back behind him, slowly and with easing.
 *  - He slides along obstacles instead of stopping dead.
 */
const WALK_SPEED = 2.3; // m/s, as in Blender
const RUN_SPEED = 3.8;
const TURN_SPEED = 10; // rad/s: an about-face takes about a third of a second
const STEP_LIMIT = 0.28; // m change in ground height per step (steeper = a ledge)
const FOOT_LIFT = 0.055;
const CAM_BACK = 10;
const CAM_UP = 13;
const LOOK_MAX = THREE.MathUtils.degToRad(28); // cursor look, at the screen edge
const SWING_SECONDS = 1.4; // "look ahead" swing
const CLIP_SPEED = 1.625; // walk clip plays at 1.0 when moving at this speed
const LIFT_UP = 9; // extra height when scenery hides him (camera tilts towards overhead)
const LIFT_BACK = -4; // ...and comes a little closer horizontally

export interface WalkerStatus {
  speed: number;
  message: string;
  position: THREE.Vector3;
}

export class Walker {
  readonly position = new THREE.Vector3();
  /** Local up (unit, from the planet centre). */
  readonly n = new THREE.Vector3();
  /** Where he faces (tangent). */
  readonly facing = new THREE.Vector3();
  /** Where the camera looks from behind (tangent). Only turns when the player asks. */
  private camHeading = new THREE.Vector3();
  private lookYaw = 0;
  /** 0..1: how far the camera has risen to see over scenery that hides him. */
  private lift = 0;
  /** Merged scenery chunks with their world bounding spheres, for the camera's visibility check. */
  private occluders: { mesh: THREE.Mesh; sphere: THREE.Sphere }[] = [];
  private nearby: THREE.Mesh[] = [];
  private clearFor = 0;
  private occlusionClock = 0;
  private hiddenNow = false;
  /** Load-time costs (ms), shown with ?debug. */
  readonly timings: Record<string, number> = {};
  private swing?: { from: THREE.Vector3; to: THREE.Vector3; t: number };
  private keys = new Set<string>();
  private cursorX: number | null = null;
  private speed = 0;
  private stride = 0;
  message = '';
  /** False while something covers the world (the full-page map): the keys don't move him. */
  enabled = true;

  private ground: THREE.Mesh;
  private obstacles: THREE.Mesh;
  private ray = new THREE.Raycaster();
  private root: THREE.Object3D;
  private mixer?: THREE.AnimationMixer;
  private idle?: THREE.AnimationAction;
  private walk?: THREE.AnimationAction;
  private blob: THREE.Mesh;
  private camPos = new THREE.Vector3();
  private center: THREE.Vector3;
  private radius: number;
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private m = new THREE.Matrix4();

  constructor(
    private camera: THREE.PerspectiveCamera,
    private dom: HTMLElement,
    world: THREE.Object3D,
    private manifest: Manifest,
    animations: THREE.AnimationClip[],
  ) {
    this.center = new THREE.Vector3(...manifest.movement.center);
    this.radius = manifest.movement.nominalRadius ?? 23;
    this.ray.firstHitOnly = true;
    const root = world.getObjectByName(manifest.character.node);
    if (!root) throw new Error(`The character “${manifest.character.node}” is missing from the model.`);
    this.root = root;
    this.root.matrixAutoUpdate = true;

    // Collision surfaces from the roles the export stored on every mesh.
    let t0 = performance.now();
    const groundGeo: THREE.BufferGeometry[] = [];
    const solidGeo: THREE.BufferGeometry[] = [];
    world.updateMatrixWorld(true);
    world.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || (mesh as THREE.SkinnedMesh).isSkinnedMesh || mesh.name.startsWith('hover_')) return;
      let role: string | undefined;
      for (let p: THREE.Object3D | null = mesh; p && !role; p = p.parent) role = p.userData?.collision_role as string | undefined;
      if (role !== 'ground' && role !== 'solid') return;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', mesh.geometry.attributes.position.clone());
      if (mesh.geometry.index) g.setIndex(mesh.geometry.index.clone());
      g.applyMatrix4(mesh.matrixWorld);
      (role === 'ground' ? groundGeo : solidGeo).push(g.index ? g : g);
    });
    const merge = (list: THREE.BufferGeometry[]) => {
      const indexed = list.map((g) => (g.index ? g : (() => { const i = []; for (let k = 0; k < g.attributes.position.count; k++) i.push(k); g.setIndex(i); return g; })()));
      const merged = mergeGeometries(indexed, false) ?? new THREE.BufferGeometry();
      return new THREE.Mesh(merged, new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }));
    };
    this.ground = merge(groundGeo);
    this.obstacles = merge(solidGeo);
    this.timings.collect = performance.now() - t0; t0 = performance.now();
    this.ground.geometry.computeBoundsTree();
    this.timings.ground = performance.now() - t0;
    this.obstaclesReady = this.buildObstacles();

    // His real shadow is not in the (drawn-once) shadow map; a soft round shadow follows him.
    root.traverse((o) => { (o as THREE.Mesh).castShadow = false; });
    this.blob = makeBlobShadow();
    world.parent?.add(this.blob);

    if (animations.length) {
      this.mixer = new THREE.AnimationMixer(root);
      const idleClip = THREE.AnimationClip.findByName(animations, 'Idle');
      const walkClip = THREE.AnimationClip.findByName(animations, 'Walk');
      if (idleClip) { this.idle = this.mixer.clipAction(idleClip); this.idle.play(); }
      if (walkClip) { this.walk = this.mixer.clipAction(walkClip); this.walk.play(); this.walk.setEffectiveWeight(0); }
    }

    this.bindInput();
    this.reset();
  }

  /** The obstacle search tree (half a million triangles) is built in a background worker so the
   *  world appears sooner; he waits for it before taking his first step (about a second). */
  readonly obstaclesReady: Promise<void>;
  private obstaclesBuilt = false;

  private async buildObstacles(): Promise<void> {
    const t0 = performance.now();
    const geometry = this.obstacles.geometry;
    try {
      const worker = new GenerateMeshBVHWorker();
      geometry.boundsTree = await worker.generate(geometry);
      worker.dispose();
    } catch (err) {
      console.warn('[walker] Background build unavailable; building obstacles here.', err);
      geometry.computeBoundsTree();
    }
    this.obstaclesBuilt = true;
    this.timings.obstacles = performance.now() - t0;
  }

  get stats(): { ground: number; obstacles: number } {
    return {
      ground: (this.ground.geometry.index?.count ?? 0) / 3,
      obstacles: (this.obstacles.geometry.index?.count ?? 0) / 3,
    };
  }

  /** Back to the starting point (R). */
  reset(): void {
    const s = this.manifest.spawn;
    this.n.set(...s.up).normalize();
    this.facing.set(...s.forward);
    this.tangent(this.facing, this.n);
    this.camHeading.copy(this.facing);
    this.lookYaw = 0;
    this.lift = 0;
    this.hiddenNow = false;
    this.clearFor = 0;
    this.swing = undefined;
    this.speed = this.stride = 0;
    const g = this.groundPoint(this.n);
    this.position.copy(g ?? new THREE.Vector3(...s.position));
    this.applyPose(0, 1);
    this.updateCamera(1, true);
  }

  /** Scenery the camera should see past (the merged, drawn scenery). */
  setOccluders(objects: THREE.Object3D[]): void {
    const t0 = performance.now();
    this.occluders = [];
    for (const o of objects) {
      o.updateMatrixWorld(true);
      o.traverse((m) => {
        const mesh = m as THREE.Mesh;
        if (!mesh.isMesh) return;
        if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
        this.occluders.push({ mesh, sphere: mesh.geometry.boundingSphere!.clone().applyMatrix4(mesh.matrixWorld) });
      });
    }
    this.timings.occluders = performance.now() - t0;
    // Search trees for the chunks are built a few at a time after the world first appears.
    let next = 0;
    const work = () => {
      const until = performance.now() + 6;
      while (next < this.occluders.length && performance.now() < until) {
        const g = this.occluders[next++].mesh.geometry;
        if (!g.boundsTree) g.computeBoundsTree();
      }
      if (next < this.occluders.length) setTimeout(work, 16);
      else this.timings.occluderTrees = performance.now() - t0;
    };
    setTimeout(work, 200);
  }

  /**
   * How close he can actually get to a point walking straight at it from `from` (with the real
   * collision rules), without moving him. Used to find where "in front of the door" is when
   * steps or a porch keep him back from the door itself.
   */
  closestApproach(from: THREE.Vector3, target: THREE.Vector3, maxMetres = 6): number {
    const save = [this.position.clone(), this.n.clone(), this.facing.clone(), this.camHeading.clone()] as const;
    const msg = this.message, swing = this.swing;
    this.swing = undefined;
    const n = from.clone().sub(this.center).normalize();
    const start = this.groundPoint(n);
    let best = Infinity;
    if (start) {
      this.position.copy(start); this.n.copy(n);
      const dir = new THREE.Vector3();
      for (let travelled = 0; travelled < maxMetres; ) {
        dir.copy(target).sub(this.position); this.tangent(dir, this.n);
        best = Math.min(best, this.position.distanceTo(target));
        const moved = this.moveOnce(dir, 0.05, false);
        if (moved <= 0) break;
        travelled += moved;
      }
      best = Math.min(best, this.position.distanceTo(target));
    }
    [this.position, this.n, this.facing, this.camHeading].forEach((v, i) => v.copy(save[i]));
    this.message = msg; this.swing = swing;
    return best;
  }

  /** Swing the camera round behind him, gently (Space / C / the button). */
  lookAhead(): void {
    this.swing = { from: this.camHeading.clone(), to: this.facing.clone(), t: 0 };
  }

  update(dt: number): void {
    dt = Math.min(Math.max(dt, 0), 0.1);
    // Substeps keep collision reliable during a slow frame.
    const steps = Math.max(1, Math.ceil(dt / (1 / 60)));
    for (let i = 0; i < steps; i++) this.step(dt / steps);
    this.mixer?.update(dt);
    this.updateCamera(dt);
  }

  private step(dt: number): void {
    if (!this.enabled) { this.speed = 0; return; }
    // Screen-relative input, measured against the direction the camera is looking.
    const up = +(this.keys.has('ArrowUp') || this.keys.has('KeyW')) - +(this.keys.has('ArrowDown') || this.keys.has('KeyS'));
    const right = +(this.keys.has('ArrowRight') || this.keys.has('KeyD')) - +(this.keys.has('ArrowLeft') || this.keys.has('KeyA'));
    const view = this.viewHeading(this.tmp2);
    const viewRight = this.tmp.copy(view).cross(this.n).normalize();
    const wish = new THREE.Vector3().addScaledVector(view, up).addScaledVector(viewRight, right);
    const running = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    let moved = 0;
    this.message = '';
    if (wish.lengthSq() > 1e-6) {
      wish.normalize();
      // Turn to face the direction of travel: a real turn about the local up axis, so an
      // about-face (↓ while facing away) swings round instead of cancelling out.
      let turn = Math.atan2(this.tmp.copy(this.facing).cross(wish).dot(this.n), this.facing.dot(wish));
      if (Math.abs(turn) > Math.PI - 1e-3) turn = -Math.PI; // exactly behind: pick one way round
      const maxTurn = TURN_SPEED * dt;
      this.facing.applyAxisAngle(this.n, THREE.MathUtils.clamp(turn, -maxTurn, maxTurn));
      this.tangent(this.facing, this.n);
      const distance = (running ? RUN_SPEED : WALK_SPEED) * dt;
      moved = this.tryMove(wish, distance);
    }
    this.speed = moved / Math.max(dt, 1e-6);
  }

  /** Move along `dir`; if blocked, try sliding a little either side. Returns distance moved. */
  private tryMove(dir: THREE.Vector3, distance: number): number {
    for (const angle of [0, 0.6, -0.6, 1.1, -1.1]) {
      const d = angle ? dir.clone().applyAxisAngle(this.n, angle) : dir;
      const scale = Math.cos(angle);
      if (scale < 0.3) continue;
      const moved = this.moveOnce(d, distance * scale, angle === 0);
      if (moved > 0) return moved;
    }
    return 0;
  }

  private moveOnce(dir: THREE.Vector3, distance: number, report: boolean): number {
    const axis = this.tmp.copy(this.n).cross(dir).normalize();
    const angle = distance / this.position.distanceTo(this.center);
    this.q.setFromAxisAngle(axis, angle);
    const newN = this.n.clone().applyQuaternion(this.q);
    if (this.pastCoast(newN)) { if (report) this.message = 'Ocean edge — follow the beach'; return 0; }
    const candidate = this.groundPoint(newN);
    const here = this.position.distanceTo(this.center);
    if (!candidate || Math.abs(candidate.distanceTo(this.center) - here) > STEP_LIMIT) {
      if (report) this.message = 'Find a gentler route';
      return 0;
    }
    if (!this.obstaclesBuilt) { if (report) this.message = 'Getting ready…'; return 0; }
    if (!this.pathClear(this.position, candidate, this.n, dir)) { if (report) this.message = 'Turn to walk around'; return 0; }
    const moved = candidate.distanceTo(this.position);
    this.position.copy(candidate);
    this.n.copy(newN);
    // Carry the facing and camera heading along the curved surface.
    this.facing.applyQuaternion(this.q); this.tangent(this.facing, this.n);
    this.camHeading.applyQuaternion(this.q); this.tangent(this.camHeading, this.n);
    if (this.swing) {
      this.swing.from.applyQuaternion(this.q); this.swing.to.applyQuaternion(this.q);
    }
    return moved;
  }

  /** Same test as Blender: the coastline curve on the planet, in Blender axes (x, y, z) = (x, -z, y). */
  private pastCoast(n: THREE.Vector3): boolean {
    if (this.manifest.id !== 'carmel') return false;
    const bx = n.x, by = -n.z, bz = n.y;
    const coast = 0.665 + 0.024 * Math.sin(by * 11) + 0.015 * Math.cos(bz * 9);
    return bx > coast - 0.005;
  }

  private groundPoint(n: THREE.Vector3): THREE.Vector3 | null {
    const from = this.tmp2.copy(n).multiplyScalar(this.radius + 13).add(this.center);
    this.ray.set(from, n.clone().negate());
    this.ray.far = 20;
    const hit = this.ray.intersectObject(this.ground, false)[0];
    return hit ? hit.point.clone().addScaledVector(n, FOOT_LIFT) : null;
  }

  /** Three heights × three widths, as in Blender, so thin trunks and walls can't be slipped through. */
  private pathClear(start: THREE.Vector3, end: THREE.Vector3, n: THREE.Vector3, forward: THREE.Vector3): boolean {
    const delta = end.clone().sub(start);
    const length = delta.length();
    if (length < 1e-7) return true;
    const dir = delta.divideScalar(length);
    const right = forward.clone().cross(n).normalize();
    this.ray.far = length + 0.26;
    for (const h of [0.32, 0.9, 1.55]) {
      for (const side of [-0.25, 0, 0.25]) {
        const origin = start.clone().addScaledVector(n, h).addScaledVector(right, side);
        this.ray.set(origin, dir);
        if (this.ray.intersectObject(this.obstacles, false).length) return false;
      }
    }
    return true;
  }

  private applyPose(_speed: number, dt: number): void {
    // Blend idle and walk from how fast he actually moved (no sliding feet when blocked).
    const target = Math.min(1, this.speed / 1.8);
    this.stride += (target - this.stride) * (1 - Math.exp(-10 * dt));
    this.walk?.setEffectiveWeight(this.stride);
    this.idle?.setEffectiveWeight(1 - this.stride);
    if (this.walk) this.walk.timeScale = Math.max(0.2, this.speed / CLIP_SPEED);
    // Orientation: local +Y = up, +Z = facing.
    const x = this.tmp.copy(this.n).cross(this.facing).normalize();
    this.m.makeBasis(x, this.n, this.facing);
    this.root.quaternion.setFromRotationMatrix(this.m);
    this.root.position.copy(this.position);
    if (this.root.parent) {
      // Courier sits directly under the world root; convert world pose to parent space.
      const inv = this.m.copy(this.root.parent.matrixWorld).invert();
      this.root.position.applyMatrix4(inv);
      const pq = new THREE.Quaternion();
      this.root.parent.getWorldQuaternion(pq);
      this.root.quaternion.premultiply(pq.invert());
    }
    this.blob.position.copy(this.position).addScaledVector(this.n, 0.03 - FOOT_LIFT);
    this.blob.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.n);
  }

  /** Direction the view is looking, including the cursor's gentle left/right look. */
  private viewHeading(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.camHeading).applyAxisAngle(this.n, -this.lookYaw);
  }

  private updateCamera(dt: number, snap = false): void {
    this.applyPose(this.speed, dt);
    // Look-ahead swing: ease the camera heading round to where he faces.
    if (this.swing) {
      this.swing.t = Math.min(1, this.swing.t + dt / SWING_SECONDS);
      const k = this.swing.t * this.swing.t * (3 - 2 * this.swing.t);
      const a = this.tangent(this.swing.from.clone(), this.n), b = this.tangent(this.swing.to.clone(), this.n);
      const signed = Math.atan2(a.clone().cross(b).dot(this.n), a.dot(b));
      this.camHeading.copy(a).applyAxisAngle(this.n, signed * k);
      this.lookYaw *= 1 - k * 0.2;
      if (this.swing.t >= 1) this.swing = undefined;
    }
    // Cursor look: a dead zone in the middle, ramping to LOOK_MAX at the edges.
    let targetYaw = 0;
    if (this.cursorX !== null) {
      const x = this.cursorX * 2 - 1;
      const dead = 0.35;
      const t = Math.max(0, (Math.abs(x) - dead) / (1 - dead));
      targetYaw = Math.sign(x) * LOOK_MAX * t * t * (3 - 2 * t);
    }
    this.lookYaw += (targetYaw - this.lookYaw) * (1 - Math.exp(-2.2 * dt));

    const heading = this.viewHeading(this.tmp2.clone());
    const target = this.position.clone().addScaledVector(this.n, 1.15).addScaledVector(heading, 0.65);
    // Scenery hiding him: rise gently to a more overhead angle, rather than cutting closer.
    // Rise while he is hidden; hold while he is visible; come back down only once the normal
    // camera position would see him clearly for a moment (no bobbing at the edge of a roof).
    // Scenery hiding him: rise gently to a more overhead angle, rather than cutting closer.
    // Rise while he is hidden; hold while he is visible; come back down only once the normal
    // camera position would see him clearly for a moment (no bobbing at the edge of a roof).
    if (!snap && this.occluders.length) {
      // Checked 15 times a second (the easing hides the gaps); the resting camera position is
      // only tested separately while the camera is raised.
      this.occlusionClock += dt;
      if (this.occlusionClock >= 1 / 15) {
        const base = this.position.clone().addScaledVector(heading, -CAM_BACK).addScaledVector(this.n, CAM_UP);
        this.hiddenNow = this.hidden(this.camera.position);
        const hiddenAtBase = this.lift < 0.02 ? this.hiddenNow : this.hidden(base);
        this.clearFor = hiddenAtBase ? 0 : this.clearFor + this.occlusionClock;
        this.occlusionClock = 0;
      }
      const want = this.hiddenNow ? 1 : this.clearFor > 0.7 ? 0 : this.lift;
      this.lift += (want - this.lift) * (1 - Math.exp(-(want > this.lift ? 1.8 : 0.8) * dt));
    }
    const desired = this.position.clone()
      .addScaledVector(heading, -(CAM_BACK + LIFT_BACK * this.lift))
      .addScaledVector(this.n, CAM_UP + LIFT_UP * this.lift);
    if (snap) this.camPos.copy(desired);
    else this.camPos.lerp(desired, 1 - Math.exp(-7 * dt));
    // Keep the camera clear of the ground when rounding hills (as in Blender).
    const cn = this.camPos.clone().sub(this.center).normalize();
    const floor = this.groundPoint(cn);
    const minR = floor ? floor.distanceTo(this.center) + 0.4 : 0;
    if (this.camPos.distanceTo(this.center) < minR) this.camPos.copy(cn.multiplyScalar(minR).add(this.center));
    this.camera.position.copy(this.camPos);
    this.camera.up.copy(this.n);
    this.camera.lookAt(target);
  }

  /** Is any of him hidden from `eye`? Head, middle, feet and either side. */
  private hidden(eye: THREE.Vector3): boolean {
    if (!this.gatherNearby(this.position, eye)) return false;
    const side = this.tmp.copy(this.facing).cross(this.n).normalize().clone();
    for (const [h, o] of [[1.15, 0], [0.6, 0], [0.2, 0], [0.7, 0.3], [0.7, -0.3]]) {
      const p = this.position.clone().addScaledVector(this.n, h).addScaledVector(side, o);
      const toEye = eye.clone().sub(p);
      const len = toEye.length();
      this.ray.set(p, toEye.divideScalar(len));
      this.ray.far = len - 0.5;
      if (this.ray.intersectObjects(this.nearby, false).length) return true;
    }
    return false;
  }

  /** Only the few chunks near the line between two points can be in the way. */
  private gatherNearby(a: THREE.Vector3, b: THREE.Vector3): number {
    const mid = this.tmp.copy(a).add(b).multiplyScalar(0.5);
    const reach = b.distanceTo(a) / 2 + 1.6;
    this.nearby.length = 0;
    for (const o of this.occluders) {
      if (!o.mesh.geometry.boundsTree) continue; // not built yet (first moments after loading)
      const r = reach + o.sphere.radius;
      if (o.sphere.center.distanceToSquared(mid) < r * r) this.nearby.push(o.mesh);
    }
    return this.nearby.length;
  }

  private tangent(v: THREE.Vector3, n: THREE.Vector3): THREE.Vector3 {
    return v.addScaledVector(n, -v.dot(n)).normalize();
  }

  private bindInput(): void {
    const movement = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'ShiftRight']);
    window.addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (movement.has(e.code)) {
        this.keys.add(e.code);
        if (e.code.startsWith('Arrow')) e.preventDefault();
      } else if ((e.code === 'Space' || e.code === 'KeyC') && !e.repeat) {
        // Space on a focused button should still press that button.
        if (e.code === 'Space' && tag === 'BUTTON') return;
        e.preventDefault();
        this.lookAhead();
      } else if (e.code === 'KeyR' && !e.repeat && !e.metaKey && !e.ctrlKey) {
        this.reset();
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    this.dom.addEventListener('pointermove', (e) => { this.cursorX = e.clientX / window.innerWidth; });
    this.dom.addEventListener('pointerleave', () => { this.cursorX = null; });
  }
}

function makeBlobShadow(): THREE.Mesh {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  grad.addColorStop(0, 'rgba(40,36,30,0.55)');
  grad.addColorStop(0.55, 'rgba(40,36,30,0.28)');
  grad.addColorStop(1, 'rgba(40,36,30,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1.1, 1.1),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, toneMapped: false }),
  );
  mesh.name = 'courier-shadow';
  mesh.renderOrder = 2;
  return mesh;
}
