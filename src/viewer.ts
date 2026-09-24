import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { applyLighting } from './lighting';
import { batchStaticMeshes } from './batching';
import { Walker } from './walker';
import type { Manifest, Vec3, Viewpoint } from './types';

export interface ViewerStats {
  fps: number;
  drawCalls: number;
  triangles: number;
  meshes: number;
  loadSeconds: number;
}

export interface AxisCheck {
  ok: boolean;
  errorMeters: number;
  note: string;
}

const v3 = (a: Vec3) => new THREE.Vector3(a[0], a[1], a[2]);

/** One reusable 3D view. It knows nothing about any particular model beyond its manifest. */
export class WorldViewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(40, 1, 0.1, 600);
  controls: OrbitControls;
  manifest?: Manifest;
  gltf?: GLTF;
  axisCheck?: AxisCheck;
  views: Viewpoint[] = [];

  private mixer?: THREE.AnimationMixer;
  private timer = new THREE.Timer();
  private fovLarger = 40;
  private frames = 0;
  private fpsTime = 0;
  private fps = 0;
  /** Resolution scaling: on a slow frame rate the canvas draws at fewer pixels (Retina screens
   *  are 2×), and goes back up when there's headroom. ?fixedres turns it off. */
  private maxPixelRatio = Math.min(window.devicePixelRatio, 2);
  private pixelRatio = this.maxPixelRatio;
  private adaptive = !new URLSearchParams(window.location.search).has('fixedres');
  private cooldown = 0;
  private loadSeconds = 0;
  private flight?: { from: Viewpoint; to: Viewpoint; t: number; duration: number };
  private radius = 23;
  private center = new THREE.Vector3();
  private debugGroup?: THREE.Group;
  batchInfo?: { sourceMeshes: number; chunks: number };
  batchGroup?: THREE.Group;
  /** Called every frame before drawing (tooltips, UI that follows the 3D view). */
  readonly onFrame: ((dt: number) => void)[] = [];
  /** 'walk' (default): the paperboy is played. 'orbit' (?orbit): free camera for inspection tools. */
  readonly mode: 'walk' | 'orbit' = new URLSearchParams(window.location.search).has('orbit') ? 'orbit' : 'walk';
  walker?: Walker;

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);
    this.controls = this.makeControls(new THREE.Vector3(0, 1, 0));
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  /** Load a model described by its manifest. Rejects with a readable Error. */
  async load(manifestUrl: string, onProgress: (fraction: number | null) => void): Promise<void> {
    const started = performance.now();
    const manifest = await fetchJson<Manifest>(manifestUrl, 'model settings (manifest.json)');
    this.manifest = manifest;
    const base = new URL('.', new URL(manifestUrl, window.location.href)).href;
    const assetUrl = new URL(manifest.asset, base).href;

    const gltf = await new Promise<GLTF>((resolve, reject) => {
      new GLTFLoader().load(
        assetUrl,
        resolve,
        (e) => onProgress(e.lengthComputable && e.total ? e.loaded / e.total : null),
        (err) => reject(describeLoadError(err, assetUrl)),
      );
    });
    this.gltf = gltf;
    this.center.copy(v3(manifest.movement.center));
    this.radius = manifest.movement.nominalRadius ?? 23;

    const world = gltf.scene;
    world.name = `world:${manifest.id}`;
    const character = world.getObjectByName(manifest.character.node);
    world.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });
    this.scene.add(world);
    world.updateMatrixWorld(true);
    // Static scenery never moves: skip per-frame matrix work for thousands of nodes.
    const moving = new Set<THREE.Object3D>();
    character?.traverse((o) => moving.add(o));
    world.traverse((o) => {
      if (!moving.has(o) && o !== world) o.matrixAutoUpdate = false;
    });
    // Draw static scenery in a few hundred merged chunks (?nobatch shows the raw objects).
    const query = new URLSearchParams(window.location.search);
    if (!query.has('nobatch')) {
      const batch = batchStaticMeshes(world, moving, Number(query.get('cell')) || 24);
      this.scene.add(batch.group);
      this.batchGroup = batch.group;
      this.batchInfo = { sourceMeshes: batch.sourceMeshes, chunks: batch.chunks };
    }

    applyLighting(this.renderer, this.scene, manifest.lighting, this.radius);

    if (this.mode === 'walk') {
      character?.traverse((o) => { o.frustumCulled = false; });
      this.walker = new Walker(this.camera, this.renderer.domElement, world, manifest, gltf.animations);
      if (this.batchGroup) this.walker.setOccluders([this.batchGroup]);
      this.controls.enabled = false;
      this.fovLarger = 50.7; // the Blender walking camera: 38 mm lens
      this.updateFov();
    } else if (character && gltf.animations.length) {
      this.mixer = new THREE.AnimationMixer(character);
      const idle = THREE.AnimationClip.findByName(gltf.animations, 'Idle') ?? gltf.animations[0];
      this.mixer.clipAction(idle).play();
    }

    this.axisCheck = this.checkAxes(manifest);
    this.views = this.buildViews(manifest);
    if (this.mode === 'orbit') this.setView('home', false);
    this.loadSeconds = (performance.now() - started) / 1000;
  }

  /** Camera presets: whole planet, the spawn area, and each Blender presentation camera. */
  private buildViews(m: Manifest): Viewpoint[] {
    const up = v3(m.spawn.up).normalize();
    const fwd = v3(m.spawn.forward).normalize();
    const spawn = v3(m.spawn.position);
    const homePos = spawn.clone().addScaledVector(up, 17).addScaledVector(fwd, -15);
    const views: Viewpoint[] = [
      { id: 'home', label: 'Start', position: homePos.toArray() as Vec3, target: spawn.toArray() as Vec3, fovDegrees: 60 },
      { id: 'planet', label: 'Whole planet', position: spawn.clone().normalize().multiplyScalar(this.radius * 4.2).toArray() as Vec3, target: m.movement.center, fovDegrees: 50 },
    ];
    return views.concat((m.viewpoints ?? []).map((v) => this.asTelephoto(v)));
  }

  /**
   * The viewer stays perspective. An orthographic Blender camera is reproduced by standing far
   * back along the same line of sight with a long lens that covers the same width at the target,
   * which frames the scene almost identically and still orbits naturally.
   */
  private asTelephoto(v: Viewpoint): Viewpoint {
    if (v.projection !== 'orthographic' || !v.orthoScale) return v;
    const target = v3(v.target);
    const dir = target.clone().sub(v3(v.position)).normalize();
    const distance = this.radius * 4;
    const position = target.clone().addScaledVector(dir, -distance);
    const fovDegrees = THREE.MathUtils.radToDeg(2 * Math.atan(v.orthoScale / 2 / distance));
    return { ...v, position: position.toArray() as Vec3, fovDegrees };
  }

  setView(id: string, animate = true): void {
    const to = this.views.find((v) => v.id === id) ?? this.views[0];
    if (!animate) {
      this.applyView(to);
      return;
    }
    const from: Viewpoint = {
      id: 'current', label: '', fovDegrees: this.fovLarger,
      position: this.camera.position.toArray() as Vec3, target: this.controls.target.toArray() as Vec3,
      up: this.camera.up.toArray() as Vec3,
    };
    this.flight = { from, to, t: 0, duration: 1.1 };
  }

  private applyView(v: Viewpoint, blendFrom?: Viewpoint, t = 1): void {
    const pos = v3(v.position);
    const target = v3(v.target);
    let fov = v.fovDegrees ?? 40;
    if (blendFrom) {
      const k = t * t * (3 - 2 * t);
      // Swing around the planet rather than cutting through it.
      const a = v3(blendFrom.position).sub(this.center);
      const b = pos.clone().sub(this.center);
      const len = THREE.MathUtils.lerp(a.length(), b.length(), k) + Math.sin(Math.PI * k) * this.radius * 0.6;
      pos.copy(a.normalize().lerp(b.normalize(), k).normalize().multiplyScalar(len).add(this.center));
      target.lerpVectors(v3(blendFrom.target), target, k);
      fov = THREE.MathUtils.lerp(blendFrom.fovDegrees ?? 40, fov, k);
    }
    this.fovLarger = fov;
    // Presentation views keep their source camera's roll; other views orbit around the local
    // ground normal at the target, so "up" follows the planet.
    const groundUp = target.distanceTo(this.center) > 1e-3 ? target.clone().sub(this.center).normalize() : new THREE.Vector3(0, 1, 0);
    const finalUp = v.up ? v3(v.up).normalize() : groundUp;
    const up = blendFrom?.up && t < 1
      ? v3(blendFrom.up).lerp(finalUp, t * t * (3 - 2 * t)).normalize()
      : finalUp;
    if (!blendFrom || t >= 1) {
      this.controls.dispose();
      this.controls = this.makeControls(up);
    }
    this.camera.up.copy(up);
    this.camera.position.copy(pos);
    this.controls.target.copy(target);
    this.camera.lookAt(target);
    this.updateFov();
    this.controls.update();
  }

  private makeControls(up: THREE.Vector3): OrbitControls {
    this.camera.up.copy(up);
    const c = new OrbitControls(this.camera, this.renderer.domElement);
    c.enableDamping = true;
    c.dampingFactor = 0.08;
    c.minDistance = 2;
    c.maxDistance = this.radius * 7;
    c.zoomSpeed = 0.8;
    c.rotateSpeed = 0.6;
    c.screenSpacePanning = true;
    c.addEventListener('start', () => (this.flight = undefined));
    return c;
  }

  /** Compare the manifest spawn (converted by the export script) with the spawn node in the GLB. */
  private checkAxes(m: Manifest): AxisCheck {
    const node = this.gltf?.scene.getObjectByName(m.spawn.node);
    if (!node) return { ok: false, errorMeters: NaN, note: `Spawn node “${m.spawn.node}” is missing from the GLB.` };
    const p = node.getWorldPosition(new THREE.Vector3());
    const err = p.distanceTo(v3(m.spawn.position));
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(node.getWorldQuaternion(new THREE.Quaternion()));
    const fwdErr = fwd.angleTo(v3(m.spawn.forward)) * THREE.MathUtils.RAD2DEG;
    const ok = err < 0.01 && fwdErr < 1;
    return { ok, errorMeters: err, note: `spawn offset ${err.toFixed(4)} m, facing offset ${fwdErr.toFixed(2)}°` };
  }

  /** Visible markers for the axis check (?debug): red = manifest spawn, rings = GLB spawn node. */
  showDebugMarkers(on: boolean): void {
    if (!this.manifest) return;
    if (!on) {
      this.debugGroup?.removeFromParent();
      return;
    }
    if (!this.debugGroup) {
      const g = new THREE.Group();
      const m = this.manifest;
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.18, 16, 12), new THREE.MeshBasicMaterial({ color: 0xff3355, depthTest: false }));
      dot.position.copy(v3(m.spawn.position));
      dot.renderOrder = 10;
      const arrow = new THREE.ArrowHelper(v3(m.spawn.forward).normalize(), v3(m.spawn.position), 2.2, 0xff3355, 0.5, 0.3);
      const node = this.gltf?.scene.getObjectByName(m.spawn.node);
      if (node) {
        const axes = new THREE.AxesHelper(1.4);
        axes.applyMatrix4(node.matrixWorld);
        g.add(axes);
      }
      g.add(dot, arrow);
      this.debugGroup = g;
    }
    this.scene.add(this.debugGroup);
  }

  /** Stop the render loop (used for screenshot capture on slow software renderers). */
  pause(): void {
    this.renderer.setAnimationLoop(null);
  }

  /** Draw exactly one frame at the current view, with damping and flights settled. */
  renderOnce(): void {
    if (this.flight) {
      this.applyView(this.flight.to);
      this.flight = undefined;
    }
    if (this.walker) {
      this.walker.update(0);
    } else {
      this.controls.enableDamping = false;
      this.controls.update();
    }
    this.mixer?.update(0.4);
    for (const f of this.onFrame) f(0);
    this.renderer.render(this.scene, this.camera);
  }

  stats(): ViewerStats {
    let meshes = 0;
    this.scene.traverse((o) => ((o as THREE.Mesh).isMesh && o.visible ? meshes++ : 0));
    const info = this.renderer.info.render;
    return { fps: this.fps, drawCalls: info.calls, triangles: info.triangles, meshes, loadSeconds: this.loadSeconds };
  }

  get resolution(): { pixelRatio: number; max: number } {
    return { pixelRatio: this.pixelRatio, max: this.maxPixelRatio };
  }

  private adaptResolution(): void {
    if (!this.adaptive || document.hidden) return;
    this.cooldown -= 0.5;
    if (this.cooldown > 0) return;
    let next = this.pixelRatio;
    if (this.fps < 40 && this.pixelRatio > 1) next = Math.max(1, this.pixelRatio - 0.25);
    else if (this.fps > 57 && this.pixelRatio < this.maxPixelRatio) next = Math.min(this.maxPixelRatio, this.pixelRatio + 0.25);
    if (next === this.pixelRatio) return;
    const up = next > this.pixelRatio;
    this.pixelRatio = next;
    this.renderer.setPixelRatio(next);
    this.resize();
    // Wait for the new size to settle; stepping back up waits longer, to avoid see-sawing.
    this.cooldown = up ? 3 : 1;
  }

  private updateFov(): void {
    const aspect = this.camera.aspect;
    const half = THREE.MathUtils.degToRad(this.fovLarger / 2);
    // Blender "Auto" sensor fit: the field of view spans the larger screen dimension.
    this.camera.fov = aspect >= 1 ? THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(half) / aspect)) : this.fovLarger;
    this.camera.updateProjectionMatrix();
  }

  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.updateFov();
  }

  private frame(): void {
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.1);
    if (this.flight) {
      const f = this.flight;
      f.t = Math.min(1, f.t + dt / f.duration);
      this.applyView(f.to, f.from, f.t);
      if (f.t >= 1) this.flight = undefined;
    } else if (this.walker) {
      this.walker.update(dt);
    } else {
      this.controls.update();
    }
    this.mixer?.update(dt);
    for (const f of this.onFrame) f(dt);
    this.renderer.render(this.scene, this.camera);
    this.frames++;
    this.fpsTime += dt;
    if (this.fpsTime >= 0.5) {
      this.fps = this.frames / this.fpsTime;
      this.frames = 0;
      this.fpsTime = 0;
      this.adaptResolution();
    }
  }
}

async function fetchJson<T>(url: string, what: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new Error(fileProtocolHint() ?? `Couldn't reach the ${what} at ${url}.`);
  }
  if (!res.ok) throw new Error(`The ${what} wasn't found (${res.status}) at ${url}.`);
  try {
    return (await res.json()) as T;
  } catch {
    throw new Error(`The ${what} at ${url} isn't valid JSON.`);
  }
}

function fileProtocolHint(): string | null {
  return window.location.protocol === 'file:'
    ? 'This page was opened as a file. Browsers block model loading that way — start it with “npm run dev” (or any local web server) and open the address it prints.'
    : null;
}

function describeLoadError(err: unknown, url: string): Error {
  const hint = fileProtocolHint();
  if (hint) return new Error(hint);
  const text = err instanceof Error ? err.message : String(err);
  if (/404|not found/i.test(text)) return new Error(`The model file wasn't found at ${url}. Re-run the Blender export or check “asset” in manifest.json.`);
  return new Error(`The model file at ${url} couldn't be read (${text}). Re-export the GLB from Blender and try again.`);
}
