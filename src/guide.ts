import * as THREE from 'three';
import type { WorldViewer } from './viewer';
import { LandmarkPicker } from './landmarks';
import type { GuideConfig } from './map';
import { routeSvg, FOLDED_MAP_SVG, type RouteStopView } from './routemap';
import { letterIcon } from './lettericons';

export interface Description {
  title: string;
  description: string;
}

function findModelNode(world: THREE.Object3D, name: string): THREE.Object3D | undefined {
  let found: THREE.Object3D | undefined;
  world.traverse((node) => {
    if (node.name === name || node.userData?.name === name) found = node;
  });
  return found;
}

function setBubbleLines(bubble: HTMLElement, lines: string | string[]): void {
  bubble.replaceChildren(...(Array.isArray(lines) ? lines : [lines]).map((line) => {
    const p = document.createElement('p');
    p.textContent = line;
    return p;
  }));
}

/**
 * Hover tooltips and the route map. Text comes from descriptions.json and the route and map
 * layers from guide.json, both next to the model, so wording and order change without a re-export.
 */
export class Guide {
  private picker: LandmarkPicker;
  private ndc = new THREE.Vector2();
  private pointer = { x: 0, y: 0, inside: false, moved: false, down: false, downX: 0, downY: 0 };
  private hovered: string | null = null;
  private hoverSince = 0;
  private pinned: string | null = null;
  private tip: HTMLDivElement;
  private card: HTMLDivElement;
  private tmp = new THREE.Vector3();
  private tmpMatrix = new THREE.Matrix4();
  private mapOpen = false;
  private visited = new Set<string>();
  private conversationNpc?: THREE.Object3D;
  private npcBubble?: HTMLDivElement;
  private replyBubble?: HTMLDivElement;
  private conversationShown = false;
  private greetingBubble: HTMLDivElement;
  private greetings: { node: THREE.Object3D; text: string }[] = [];
  private currentGreeting?: THREE.Object3D;
  private phoneEnter: HTMLButtonElement;
  private pollingOverlay: HTMLElement;
  private pollingOpen = false;

  constructor(
    private viewer: WorldViewer,
    private config: GuideConfig,
    private text: Record<string, Description>,
  ) {
    const gltf = viewer.gltf!;
    const occluders = viewer.batchGroup ? [viewer.batchGroup] : [gltf.scene];
    this.picker = new LandmarkPicker(gltf.scene, config.tooltips, occluders);

    this.tip = document.querySelector('#tooltip') as HTMLDivElement;
    this.card = document.querySelector('#place-card') as HTMLDivElement;
    this.greetingBubble = document.querySelector('#greeting-bubble') as HTMLDivElement;
    this.phoneEnter = document.querySelector('#enter-phone-booth') as HTMLButtonElement;
    this.pollingOverlay = document.querySelector('#polling-loading') as HTMLElement;
    (document.querySelector('#place-card-close') as HTMLButtonElement).addEventListener('click', () => this.unpin());
    this.phoneEnter.addEventListener('click', () => {
      if (this.pinned !== 'phone_booth' || !this.viewer.walker) return;
      this.pollingOpen = true;
      this.viewer.walker.enabled = false;
      this.pollingOverlay.hidden = false;
      this.pollingOverlay.focus();
    });
    const leaveBooth = () => {
      if (!this.pollingOpen) return;
      this.pollingOpen = false;
      this.pollingOverlay.hidden = true;
      if (this.viewer.walker) this.viewer.walker.enabled = true;
      this.phoneEnter.focus();
    };
    this.pollingOverlay.addEventListener('click', leaveBooth);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.pollingOpen) { e.stopImmediatePropagation(); leaveBooth(); }
    });

    viewer.onFrame.push(() => this.frame());
    this.drawMap();
    if (viewer.walker) {
      // Walking: cards appear by walking up to a building; the mouse only looks around.
      this.card.classList.add('auto');
      if (config.conversation) {
        this.conversationNpc = findModelNode(gltf.scene, config.conversation.npcNode);
        this.npcBubble = document.querySelector('#conversation-npc') as HTMLDivElement;
        this.replyBubble = document.querySelector('#conversation-reply') as HTMLDivElement;
        if (!this.conversationNpc) console.warn(`[guide] Conversation character “${config.conversation.npcNode}” not found.`);
        setBubbleLines(this.npcBubble, config.conversation.npcText);
        setBubbleLines(this.replyBubble, config.conversation.replyText);
      }
      for (const greeting of config.greetings ?? []) {
        const node = findModelNode(gltf.scene, greeting.npcNode);
        if (node) this.greetings.push({ node, text: greeting.text });
        else console.warn(`[guide] Greeting character “${greeting.npcNode}” not found.`);
      }
      const walker = viewer.walker;
      void walker.obstaclesReady.then(() => {
        // Where "at the door" is: the nearest he can get to it, walking straight up to it.
        for (const t of this.picker.targets) {
          if (!t.door || config.doorRange?.[t.id]) continue;
          const d = t.door;
          const reach = walker.closestApproach(d.base.clone().addScaledVector(d.out, 4), d.base);
          t.door.standoff = Number.isFinite(reach) ? Math.max(0, reach - 0.5) : 0;
        }
      });
      return;
    }
    const el = viewer.renderer.domElement;
    el.addEventListener('pointermove', (e) => {
      Object.assign(this.pointer, { x: e.clientX, y: e.clientY, inside: true, moved: true });
    });
    el.addEventListener('pointerleave', () => {
      this.pointer.inside = false;
      this.setHover(null);
    });
    el.addEventListener('pointerdown', (e) => Object.assign(this.pointer, { down: true, downX: e.clientX, downY: e.clientY }));
    el.addEventListener('pointerup', (e) => {
      const click = Math.hypot(e.clientX - this.pointer.downX, e.clientY - this.pointer.downY) < 5;
      this.pointer.down = false;
      if (!click) return; // a drag orbits the camera; it never pins or unpins
      const id = this.pickAt(e.clientX, e.clientY);
      if (id) this.pin(id);
      else this.unpin();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.unpin();
    });
  }

  private pickAt(x: number, y: number): string | null {
    const rect = this.viewer.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
    return this.picker.pick(this.ndc, this.viewer.camera);
  }

  private frame(): void {
    if (this.viewer.walker) {
      this.frameWalking();
      return;
    }
    // One pick per frame at most, and none while dragging.
    if (this.pointer.moved && this.pointer.inside && !this.pointer.down) {
      this.pointer.moved = false;
      this.setHover(this.pickAt(this.pointer.x, this.pointer.y));
    }
    const d = this.hovered ? this.text[this.hovered] : undefined;
    const showTip = !!d && this.hovered !== this.pinned && performance.now() - this.hoverSince > 220;
    this.tip.hidden = !showTip;
    if (showTip) this.placeNear(this.tip, this.pointer.x + 16, this.pointer.y + 18);
    if (this.pinned) this.placePinned();
  }

  /**
   * Walk-up cards: a building's card opens when he stands at its front door, facing it.
   * Looser limits keep it open than open it, so it doesn't flicker at the edge.
   * (Buildings without a door in the model fall back to being near and facing it.)
   */
  private frameWalking(): void {
    const w = this.viewer.walker!;
    let best: string | null = null, bestScore = Infinity;
    const d = new THREE.Vector3(), side = new THREE.Vector3(), toward = new THREE.Vector3(), local = new THREE.Vector3(), world = new THREE.Vector3();
    for (const t of this.picker.targets) {
      const keep = t.id === this.pinned;
      if (t.door) {
        const door = t.door;
        const range = this.config.doorRange?.[t.id];
        d.copy(w.position).sub(door.base);
        d.addScaledVector(w.n, -d.dot(w.n));
        side.copy(door.out).cross(w.n).normalize();
        const along = d.dot(door.out), across = Math.abs(d.dot(side));
        const facing = -w.facing.dot(door.out); // 1 = looking straight at the door
        const maxAlong = range ? (keep ? range.keep : range.open) : door.standoff + (keep ? 2.4 : 1.7);
        const maxAcross = range?.across ?? door.halfWidth + (keep ? 0.75 : 0.35);
        const ok = keep
          ? along > -0.2 && along < maxAlong && across < maxAcross && facing > 0.35
          : along > -0.1 && along < maxAlong && across < maxAcross && facing > 0.6;
        if (ok && along + across < bestScore) { bestScore = along + across; best = t.id; }
        continue;
      }
      const p = (t.box.geometry as THREE.BoxGeometry).parameters;
      local.copy(w.position).applyMatrix4(this.tmpMatrix.copy(t.box.matrixWorld).invert());
      local.set(
        THREE.MathUtils.clamp(local.x, -p.width / 2, p.width / 2),
        THREE.MathUtils.clamp(local.y, -p.height / 2, p.height / 2),
        THREE.MathUtils.clamp(local.z, -p.depth / 2, p.depth / 2),
      );
      world.copy(local).applyMatrix4(t.box.matrixWorld);
      const dist = world.distanceTo(w.position);
      if (dist > (keep ? 3.4 : 2.5)) continue;
      t.box.getWorldPosition(toward).sub(w.position);
      toward.addScaledVector(w.n, -toward.dot(w.n)).normalize();
      if (dist > 0.6 && toward.dot(w.facing) < (keep ? 0 : 0.3)) continue;
      if (dist < bestScore) { bestScore = dist; best = t.id; }
    }
    if (best !== this.pinned) {
      if (best) { this.pin(best); this.stamp(best); }
      else this.unpin();
    }
    if (this.pinned) this.placePinned();
    this.frameConversation();
    this.frameGreeting();
  }

  /** A brief exchange with the yellow-shirt resident after the Wally's stop. */
  private frameConversation(): void {
    if (!this.conversationNpc || !this.npcBubble || !this.replyBubble || !this.config.conversation) return;
    const w = this.viewer.walker!;
    const npc = this.conversationNpc.getWorldPosition(new THREE.Vector3());
    const delta = w.position.clone().sub(npc);
    delta.addScaledVector(w.n, -delta.dot(w.n));
    const near = delta.length() < (this.conversationShown ? 2.5 : 2.0);
    const show = this.visited.has(this.config.conversation.after) && this.pinned !== this.config.conversation.after && near && !this.mapOpen && !this.pollingOpen;
    if (!show) {
      this.conversationShown = false;
      this.npcBubble.hidden = true;
      this.replyBubble.hidden = true;
      return;
    }
    const canvas = this.viewer.renderer.domElement.getBoundingClientRect();
    const project = (point: THREE.Vector3) => {
      const p = point.project(this.viewer.camera);
      return { x: canvas.left + (p.x + 1) * canvas.width / 2, y: canvas.top + (1 - p.y) * canvas.height / 2, visible: p.z > -1 && p.z < 1 && Math.abs(p.x) < 1.1 && Math.abs(p.y) < 1.1 };
    };
    const npcUp = npc.clone().sub(new THREE.Vector3(...this.viewer.manifest!.movement.center)).normalize();
    const woman = project(npc.addScaledVector(npcUp, 1.8));
    const boy = project(w.position.clone().addScaledVector(w.n, 1.7));
    if (!woman.visible || !boy.visible) {
      this.conversationShown = false;
      this.npcBubble.hidden = true;
      this.replyBubble.hidden = true;
      return;
    }
    this.conversationShown = true;
    this.npcBubble.hidden = false;
    this.replyBubble.hidden = false;
    const margin = 12;
    const clamp = (v: number, max: number) => Math.max(margin, Math.min(v, max - margin));
    const nw = this.npcBubble.offsetWidth, nh = this.npcBubble.offsetHeight;
    const rw = this.replyBubble.offsetWidth, rh = this.replyBubble.offsetHeight;
    const nx = clamp(woman.x + 14, window.innerWidth - nw);
    let ny = clamp(woman.y - nh - 14, window.innerHeight - nh);
    let rx = clamp(boy.x - rw / 2, window.innerWidth - rw);
    const ry = clamp(boy.y - rh - 18, window.innerHeight - rh);
    if (rx < nx + nw + 10 && rx + rw + 10 > nx && ry < ny + nh + 10 && ry + rh + 10 > ny) {
      ny = clamp(ry - nh - 12, window.innerHeight - nh);
      if (ny + nh + 10 > ry) rx = clamp(nx - rw - 12, window.innerWidth - rw);
    }
    this.npcBubble.style.transform = `translate(${Math.round(nx)}px, ${Math.round(ny)}px)`;
    this.replyBubble.style.transform = `translate(${Math.round(rx)}px, ${Math.round(ry)}px)`;
  }

  /** A single short greeting from the nearest townsperson, without covering the longer exchange. */
  private frameGreeting(): void {
    if (this.conversationShown || this.mapOpen || this.pollingOpen || !this.greetings.length) {
      this.greetingBubble.hidden = true;
      this.currentGreeting = undefined;
      return;
    }
    const w = this.viewer.walker!;
    let nearest: (typeof this.greetings)[number] | undefined;
    let nearestPosition: THREE.Vector3 | undefined;
    let best = Infinity;
    for (const greeting of this.greetings) {
      const position = greeting.node.getWorldPosition(new THREE.Vector3());
      const delta = w.position.clone().sub(position);
      delta.addScaledVector(w.n, -delta.dot(w.n));
      const distance = delta.length();
      const reach = greeting.node === this.currentGreeting ? 2.5 : 2.0;
      if (distance < reach && distance < best) {
        nearest = greeting;
        nearestPosition = position;
        best = distance;
      }
    }
    if (!nearest || !nearestPosition) {
      this.greetingBubble.hidden = true;
      this.currentGreeting = undefined;
      return;
    }
    const up = nearestPosition.clone().sub(new THREE.Vector3(...this.viewer.manifest!.movement.center)).normalize();
    const projected = nearestPosition.addScaledVector(up, 1.8).project(this.viewer.camera);
    if (projected.z <= -1 || projected.z >= 1 || Math.abs(projected.x) > 1.05 || Math.abs(projected.y) > 1.05) {
      this.greetingBubble.hidden = true;
      this.currentGreeting = undefined;
      return;
    }
    if (nearest.node !== this.currentGreeting) this.greetingBubble.textContent = nearest.text;
    this.currentGreeting = nearest.node;
    this.greetingBubble.hidden = false;
    const rect = this.viewer.renderer.domElement.getBoundingClientRect();
    const x = rect.left + (projected.x + 1) * rect.width / 2;
    const y = rect.top + (1 - projected.y) * rect.height / 2;
    const width = this.greetingBubble.offsetWidth, height = this.greetingBubble.offsetHeight;
    const left = Math.max(12, Math.min(x - width / 2, window.innerWidth - width - 12));
    const top = Math.max(12, Math.min(y - height - 12, window.innerHeight - height - 12));
    this.greetingBubble.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  /** Mark a route stop as visited on the map with a star stamp. */
  private stamp(id: string): void {
    if (this.visited.has(id)) return;
    this.visited.add(id);
    const stop = document.querySelector(`#map-route .stop[data-stop="${CSS.escape(id)}"]`);
    if (!stop) return;
    stop.classList.add('stamped', 'fresh'); // 'fresh' plays the stamp-down animation when the map is next seen
    if (this.mapOpen) setTimeout(() => stop.classList.remove('fresh'), 700);
  }

  private setHover(id: string | null): void {
    if (id === this.hovered) return;
    this.hovered = id;
    this.hoverSince = performance.now();
    this.viewer.renderer.domElement.style.cursor = id ? 'pointer' : '';
    const d = id ? this.text[id] : undefined;
    if (d) {
      (this.tip.querySelector('.tip-title') as HTMLElement).textContent = d.title;
      (this.tip.querySelector('.tip-text') as HTMLElement).textContent = d.description.replace(/\s*\n\s*/g, ' ');
    }
  }

  private pin(id: string): void {
    const d = this.text[id];
    if (!d) return;
    this.pinned = id;
    (this.card.querySelector('h2') as HTMLElement).textContent = d.title;
    const copy = this.card.querySelector('.letter-copy') as HTMLElement;
    copy.replaceChildren(...d.description.split(/\n\s*\n/).filter(Boolean).map((paragraph) => {
      const p = document.createElement('p');
      p.textContent = paragraph.trim();
      return p;
    }));
    (this.card.querySelector('#letter-icon') as HTMLElement).innerHTML = letterIcon(id);
    const phoneAction = id === 'phone_booth' && !!this.viewer.walker;
    this.phoneEnter.hidden = !phoneAction;
    this.card.classList.toggle('has-action', phoneAction);
    this.card.hidden = false;
    this.placePinned();
  }

  private unpin(): void {
    this.pinned = null;
    this.card.hidden = true;
    this.phoneEnter.hidden = true;
    this.card.classList.remove('has-action');
  }

  /** Keep the pinned card beside its landmark as the camera moves; hide it when off screen. */
  private placePinned(): void {
    const t = this.picker.targets.find((x) => x.id === this.pinned);
    if (!t) return;
    const rect = this.viewer.renderer.domElement.getBoundingClientRect();
    const toScreen = (v: THREE.Vector3) => {
      const p = this.tmp.copy(v).project(this.viewer.camera);
      return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height, behind: p.z > 1 };
    };
    if (t.door && this.viewer.walker) {
      // Beside the front door, level with its top: he stands in front of the door itself,
      // so the card sits to one side of it rather than over him.
      const door = t.door;
      const top = toScreen(door.top);
      const side = new THREE.Vector3().copy(door.out).cross(this.viewer.walker.n).normalize();
      const edge = toScreen(door.top.clone().addScaledVector(side, door.halfWidth + 0.25));
      const halfW = Math.abs(edge.x - top.x);
      this.card.style.visibility = top.behind ? 'hidden' : 'visible';
      const w = this.card.offsetWidth, h = this.card.offsetHeight, m = 12;
      // Where he is on screen, so the card never covers him.
      const walker = this.viewer.walker;
      const feet = toScreen(walker.position), headPt = toScreen(walker.position.clone().addScaledVector(walker.n, 1.35));
      const boy = { l: Math.min(feet.x, headPt.x) - 45, r: Math.max(feet.x, headPt.x) + 45, t: Math.min(feet.y, headPt.y) - 20, b: Math.max(feet.y, headPt.y) + 10 };
      const y = Math.min(Math.max(m, top.y - h * 0.3), window.innerHeight - h - m);
      const clampX = (x: number) => Math.min(Math.max(m, x), window.innerWidth - w - m);
      const overlaps = (x: number, yy: number) => x < boy.r && x + w > boy.l && yy < boy.b && yy + h > boy.t;
      // Beside the door on the side away from him; failing that the other side; failing that above him.
      const away = feet.x > top.x ? -1 : 1;
      const at = (dir: number) => clampX(dir > 0 ? top.x + halfW + 22 : top.x - halfW - 22 - w);
      let left = at(away), topPx = y;
      if (overlaps(left, topPx)) left = at(-away);
      if (overlaps(left, topPx)) { left = clampX(top.x - w / 2); topPx = Math.max(m, boy.t - h - 12); }
      this.card.style.transform = `translate(${Math.round(left)}px, ${Math.round(topPx)}px)`;
      return;
    }
    const a = toScreen(t.anchor);
    this.card.style.visibility = a.behind ? 'hidden' : 'visible';
    // Prefer above the building; drop below its top when that would run off the top.
    const above = a.y - this.card.offsetHeight - 10;
    this.placeNear(this.card, a.x + 14, above < 12 ? a.y + 16 : above);
  }

  /** Position a floating element, flipping and clamping so it stays fully on screen. */
  private placeNear(el: HTMLElement, x: number, y: number): void {
    const w = el.offsetWidth, h = el.offsetHeight, m = 12;
    let left = x, top = y;
    if (left + w > window.innerWidth - m) left = x - w - 32;
    if (top + h > window.innerHeight - m) top = y - h - 36;
    left = Math.min(Math.max(m, left), window.innerWidth - w - m);
    top = Math.min(Math.max(m, top), window.innerHeight - h - m);
    el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  /** The route map: a folded paper map in the corner that opens to the stops in order. */
  private drawMap(): void {
    const stops: RouteStopView[] = [];
    let n = 0;
    for (const id of this.config.route) {
      const isStart = id === 'start';
      if (!isStart && !this.text[id] && !this.viewer.manifest!.landmarks.some((l) => l.id === id)) {
        console.warn(`[guide] Route stop “${id}” not found.`);
        continue;
      }
      stops.push({
        id,
        label: isStart ? this.config.startLabel ?? 'Start' : this.text[id]?.title ?? id,
        icon: this.config.icons?.[id] ?? 'default',
        number: isStart ? null : ++n,
      });
    }
    if (stops.length < 2) return;
    const fold = document.querySelector('#map-fold') as HTMLButtonElement;
    const panel = document.querySelector('#map') as HTMLElement;
    const close = document.querySelector('#map-close') as HTMLButtonElement;
    fold.innerHTML = FOLDED_MAP_SVG;
    (document.querySelector('#map-title') as HTMLElement).textContent = this.config.map?.title ?? 'Route';
    (document.querySelector('#map-route') as HTMLElement).innerHTML = routeSvg(stops);
    const start = document.querySelector('#map-start') as HTMLButtonElement;
    const walker = this.viewer.walker;
    let full = false;
    const setOpen = (open: boolean) => {
      if (!open && full) {
        // Leaving the full-page first screen: fold it away into the corner.
        full = false;
        if (walker) walker.enabled = true;
        close.setAttribute('aria-label', 'Fold the map');
        const done = () => { panel.classList.remove('full', 'folding'); finish(false); };
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) done();
        else { panel.classList.add('folding'); setTimeout(done, 380); }
        return;
      }
      finish(open);
    };
    const finish = (open: boolean) => {
      this.mapOpen = open;
      panel.hidden = !open;
      fold.hidden = open;
      fold.setAttribute('aria-expanded', String(open));
      (open ? close : fold).focus({ preventScroll: true });
      if (open) setTimeout(() => panel.querySelectorAll('.stop.fresh').forEach((el) => el.classList.remove('fresh')), 700);
    };
    fold.addEventListener('click', () => setOpen(true));
    close.addEventListener('click', () => setOpen(false));
    start.addEventListener('click', () => setOpen(false));
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.mapOpen) setOpen(false); });
    const query = new URLSearchParams(window.location.search);
    if (walker && !query.has('nointro') && !query.has('capture')) {
      // The first screen: the whole route, full page. He waits until it is folded away.
      full = true;
      walker.enabled = false;
      panel.classList.add('full');
      start.hidden = false;
      close.setAttribute('aria-label', 'Close the map and start');
      this.mapOpen = true;
      panel.hidden = false;
      fold.hidden = true;
      return;
    }
    fold.hidden = false;
  }
}
