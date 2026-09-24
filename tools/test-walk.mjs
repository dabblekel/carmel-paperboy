// Drives the paperboy along the route with simulated arrow keys and checks walking behaviour.
//   npx vite preview --port 4173 &   then   node tools/test-walk.mjs
// Steering picks the arrow keys that best point at the next stop, the way a player would,
// so it exercises screen-relative controls, sliding, ledges, the ocean edge and walk-up cards.
import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'docs', 'step4');
await mkdir(out, { recursive: true });
const url = process.env.VIEWER_URL ?? 'http://localhost:4173/';
const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(`${url}?still&nointro`);
await page.waitForFunction(() => window.__viewer?.ready || window.__viewer?.error, null, { timeout: 240000 });
const err = await page.evaluate(() => window.__viewer.error);
if (err) throw new Error(err);
// the camera's visibility trees finish building in the background shortly after loading
await page.waitForFunction(() => window.__viewer.viewer.walker.timings.occluderTrees && window.__viewer.viewer.walker.timings.obstacles, null, { timeout: 120000 });

const shot = async (name) => {
  await page.evaluate(() => window.__viewer.viewer.renderOnce());
  await page.screenshot({ path: path.join(out, name), timeout: 120000 });
};

// Helpers inside the page.
await page.evaluate(() => {
  const { viewer } = window.__viewer;
  const w = viewer.walker;
  const V = w.position.constructor;
  window.__walk = {
    sim(seconds, keys) {
      w.keys.clear(); keys.forEach((k) => w.keys.add(k));
      const t0 = performance.now();
      for (let t = 0; t < seconds; t += 1 / 30) { w.update(1 / 30); viewer.onFrame.forEach((f) => f(1 / 30)); }
      w.keys.clear();
      return { ms: (performance.now() - t0) / (seconds * 30), pos: w.position.toArray(), msg: w.message };
    },
    keysToward(target) {
      const to = new V(...target).sub(w.position); to.addScaledVector(w.n, -to.dot(w.n)).normalize();
      const view = w.viewHeading(new V()); const right = view.clone().cross(w.n).normalize();
      const f = to.dot(view), r = to.dot(right); const keys = [];
      if (f > 0.38) keys.push('ArrowUp'); if (f < -0.38) keys.push('ArrowDown');
      if (r > 0.38) keys.push('ArrowRight'); if (r < -0.38) keys.push('ArrowLeft');
      return keys;
    },
    /** Player-like steering: of the 8 arrow-key directions, take the one that heads most toward
     *  the goal and is clear for the next ~2 m (probing with the walker's own collision rules). */
    probe(keys, metres = 2) {
      const save = [w.position.clone(), w.n.clone(), w.facing.clone(), w.camHeading.clone(), w.message];
      const view = w.viewHeading(new V()); const right = view.clone().cross(w.n).normalize();
      const up = +keys.includes('ArrowUp') - +keys.includes('ArrowDown'), rt = +keys.includes('ArrowRight') - +keys.includes('ArrowLeft');
      const dir = new V().addScaledVector(view, up).addScaledVector(right, rt).normalize();
      let ok = 0; const start = w.position.clone();
      for (let i = 0; i < 8; i++) { const d = dir.clone(); d.addScaledVector(w.n, -d.dot(w.n)).normalize(); if (w.moveOnce(d, metres / 8, false) <= 0) break; ok++; }
      const end = w.position.clone();
      [w.position, w.n, w.facing, w.camHeading].forEach((v, i) => v.copy(save[i])); w.message = save[4];
      return { dir, clear: ok / 8, end, start };
    },
    walkTo(id, target, limit = 90, face = null) {
      const combos = [['ArrowUp'], ['ArrowDown'], ['ArrowLeft'], ['ArrowRight'], ['ArrowUp', 'ArrowLeft'], ['ArrowUp', 'ArrowRight'], ['ArrowDown', 'ArrowLeft'], ['ArrowDown', 'ArrowRight']];
      const g = window.__viewer.guide; const goal = new V(...target);
      let t = 0, blocked = 0, travelled = 0, last = w.position.clone(), keys = [], visited = [];
      while (t < limit) {
        if (g.pinned === id) return { reached: true, seconds: +t.toFixed(1), metres: +travelled.toFixed(1), blockedSeconds: +(blocked / 30).toFixed(1) };
        if (face && w.position.distanceTo(goal) < 0.6) {
          // Arrived: turn towards the door, as a player would to go in.
          keys = this.keysToward(face);
        } else if (Math.round(t * 30) % 6 === 0) {
          const to = goal.clone().sub(w.position); to.addScaledVector(w.n, -to.dot(w.n)).normalize();
          let best = -Infinity;
          for (const c of combos) {
            const p = this.probe(c);
            // prefer progress toward the goal, avoid blocked directions and recently visited spots
            let score = p.dir.dot(to) * 1.0 + p.clear * 1.2 - (p.clear < 0.25 ? 3 : 0);
            for (const v of visited) if (v.distanceTo(p.end) < 1.2) score -= 0.35;
            if (score > best) { best = score; keys = c; }
          }
          visited.push(w.position.clone()); if (visited.length > 40) visited.shift();
        }
        w.keys.clear(); keys.forEach((k) => w.keys.add(k));
        w.update(1 / 30); viewer.onFrame.forEach((f) => f(1 / 30));
        t += 1 / 30;
        const step = w.position.distanceTo(last); travelled += step; if (step < 0.004) blocked++;
        last.copy(w.position);
      }
      w.keys.clear();
      return { reached: false, seconds: limit, remaining: +w.position.distanceTo(goal).toFixed(2), blockedSeconds: +(blocked / 30).toFixed(1), msg: w.message };
    },
    state() {
      const g = window.__viewer.guide;
      const r = w.position.distanceTo(new V(0, 0, 0));
      return { pos: w.position.toArray().map((v) => +v.toFixed(2)), radius: +r.toFixed(3), card: g.pinned, msg: w.message,
               camDist: +viewer.camera.position.distanceTo(w.position).toFixed(2), stride: +w.stride.toFixed(2),
               camPitchDeg: +(Math.asin(viewer.camera.position.clone().sub(w.position).normalize().dot(w.n)) * 180 / Math.PI).toFixed(1), lift: +w.lift.toFixed(2),
               stamped: [...document.querySelectorAll('#map-route .stop.stamped')].map((e) => e.dataset.stop) };
    },
  };
});

const report = { start: await page.evaluate(() => window.__walk.state()) };
await shot('01_start.png');

// Controls: ↑ walks away from the camera, ↓ towards it (camera backs off), ← → sideways.
report.up = await page.evaluate(() => { const a = window.__walk.state(); window.__walk.sim(1.5, ['ArrowUp']); return { before: a, after: window.__walk.state() }; });
report.down = await page.evaluate(() => { const r = window.__walk.sim(1.5, ['ArrowDown']); return { ...window.__walk.state(), msPerStep: +r.ms.toFixed(2) }; });
await shot('02_walking_towards_camera.png');
report.lookAhead = await page.evaluate(() => { window.__viewer.viewer.walker.lookAhead(); window.__walk.sim(1.6, []); return window.__walk.state(); });
await shot('03_after_look_ahead.png');

// The route, stop by stop. Each goal is the spot just outside the building's front door.
const stops = await page.evaluate(() => {
  const g = window.__viewer.guide;
  return ['wallys', 'city_hall', 'post_office', 'maple_cafe', 'phone_booth'].map((id) => {
    const t = g.picker.targets.find((x) => x.id === id);
    const V = window.__viewer.viewer.camera.position.constructor;
    const pos = t.door ? t.door.base.clone().addScaledVector(t.door.out, 1.3 + t.door.standoff) : t.box.getWorldPosition(new V());
    return { id, pos: pos.toArray(), face: t.door ? t.door.base.toArray() : null, standoff: t.door?.standoff };
  });
});
await page.evaluate(() => window.__viewer.viewer.walker.reset());
report.stops = stops;
report.route = [];
for (const s of stops) {
  await page.evaluate(() => window.__walk.sim(0.5, [])); // step away so the next card has to be earned
  const r = await page.evaluate(([id, p, f]) => window.__walk.walkTo(id, p, 90, f), [s.id, s.pos, s.face]);
  const st = await page.evaluate(() => window.__walk.state());
  report.route.push({ stop: s.id, ...r, cardShown: st.card, camPitchDeg: st.camPitchDeg, lift: st.lift, stamped: st.stamped });
  // a pause at the door: the camera settles (and in the countryside rises if he's hidden)
  const after = await page.evaluate(() => { window.__walk.sim(1.5, []); return window.__walk.state(); });
  Object.assign(report.route[report.route.length - 1], { afterPause: { card: after.card, camPitchDeg: after.camPitchDeg, lift: after.lift } });
  await page.waitForTimeout(400);
  await shot(`04_door_${s.id}.png`);
}

// Ocean edge: keep walking out to sea from the phone booth.
report.ocean = await page.evaluate(() => {
  const w = window.__viewer.viewer.walker;
  // head straight away from the planet's land side (towards +x in Blender = +x here)
  const sea = w.position.clone().normalize().add(new w.position.constructor(0.6, 0, 0)).normalize().multiplyScalar(23);
  const keys = window.__walk.keysToward(sea.toArray());
  const r = window.__walk.sim(6, keys);
  return { keys, state: window.__walk.state(), coastMessage: r.msg };
});
await shot('05_ocean_edge.png');
await page.evaluate(() => document.querySelector('#map-fold').click());
await page.waitForTimeout(800);
await shot('06_map_stamps.png');

await writeFile(path.join(out, 'walk-test.json'), JSON.stringify({ report, logs }, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log(logs.filter((l) => /error|warn/i.test(l)).slice(0, 10));
await browser.close();
