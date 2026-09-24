// Checks tooltips and the route map in a real browser.
//   npx vite preview --port 4173 &   then   node tools/test-guide.mjs
// For each named view and each tooltip landmark: projects the landmark to the screen, samples
// points over its box, and asks the picker what is under each one. Reports which landmarks are
// hoverable from which views, whether any hover returns the wrong landmark, the time per pick,
// and saves screenshots of a tooltip, a pinned card and the map to docs/step3/.
import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'docs', 'step3');
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
await page.goto(`${url}?still&orbit`);
await page.waitForFunction(() => window.__viewer?.ready || window.__viewer?.error, null, { timeout: 240000 });
const err = await page.evaluate(() => window.__viewer.error);
if (err) throw new Error(err);

const report = await page.evaluate(async () => {
  const { viewer, guide } = window.__viewer;
  const g = guide;
  const V = viewer.camera.position.constructor;
  const rect = viewer.renderer.domElement.getBoundingClientRect();
  // Ground truth: first surface among ALL original meshes, owned by the landmark it belongs to.
  const originals = [];
  viewer.gltf.scene.traverse((o) => { if (o.isMesh && !o.isSkinnedMesh && !o.name.startsWith('hover_')) { if (!o.geometry.boundsTree) o.geometry.computeBoundsTree(); originals.push(o); } });
  const rc = new (g.picker.raycaster.constructor)(); rc.firstHitOnly = true;
  const ownerOf = (obj) => { for (let o = obj; o; o = o.parent) { const box = o.children?.find((c) => c.userData?.landmarkId); if (box) return box.userData.landmarkId; } return null; };
  const ndc = new (g.ndc.constructor)();
  const result = { views: {}, mismatches: [], pickMs: [] };
  for (const view of viewer.views.map((v) => v.id)) {
    viewer.setView(view, false);
    viewer.renderOnce();
    const row = {};
    let n = 0, ok = 0;
    for (let gx = 0.04; gx < 1; gx += 0.04) for (let gy = 0.04; gy < 1; gy += 0.04) {
      const x = rect.left + gx * rect.width, y = rect.top + gy * rect.height;
      const t0 = performance.now();
      const got = g.pickAt(x, y);
      result.pickMs.push(performance.now() - t0);
      ndc.set(gx * 2 - 1, -(gy * 2 - 1));
      rc.setFromCamera(ndc, viewer.camera);
      const hit = rc.intersectObjects(originals, false)[0];
      const truth = hit ? ownerOf(hit.object) : null;
      const expected = truth && g.config.tooltips.includes(truth) ? truth : null;
      if (expected || got) {
        n++;
        if (got === expected) ok++;
        else result.mismatches.push({ view, gx: +gx.toFixed(2), gy: +gy.toFixed(2), expected, got });
        if (expected) row[expected] = (row[expected] ?? 0) + (got === expected ? 1 : 0);
      }
    }
    result.views[view] = { agree: `${ok}/${n}`, hitsPerLandmark: row };
  }
  const ms = result.pickMs.sort((a, b) => a - b);
  result.pickMs = { median: +ms[Math.floor(ms.length / 2)].toFixed(2), p95: +ms[Math.floor(ms.length * 0.95)].toFixed(2), n: ms.length };
  return result;
});

// Screenshots: tooltip over Wally's, pinned card on the post office, the map (small and large).
async function hoverShot(view, id, file, pin = false) {
  const pos = await page.evaluate(({ view, id }) => {
    const { viewer, guide } = window.__viewer;
    viewer.setView(view, false);
    viewer.renderOnce();
    const rect = viewer.renderer.domElement.getBoundingClientRect();
    // find a screen point that picks this landmark
    const t = guide.picker.targets.find((x) => x.id === id);
    const V = viewer.camera.position.constructor;
    const s = t.box.geometry.parameters;
    for (const fy of [0.1, 0, 0.25, -0.15]) for (const fx of [0, -0.25, 0.25]) {
      const p = new V(fx * s.width, fy * s.height, 0).applyMatrix4(t.box.matrixWorld).project(viewer.camera);
      const x = rect.left + ((p.x + 1) / 2) * rect.width, y = rect.top + ((1 - p.y) / 2) * rect.height;
      if (guide.pickAt(x, y) === id) return { x, y };
    }
    return null;
  }, { view, id });
  if (!pos) return `no hoverable point for ${id} in ${view}`;
  await page.mouse.move(pos.x, pos.y);
  if (pin) { await page.mouse.down(); await page.mouse.up(); }
  await page.evaluate(() => window.__viewer.viewer.renderOnce()); // registers the hover
  await page.waitForTimeout(400); // tooltips appear after a short pause
  await page.evaluate(() => window.__viewer.viewer.renderOnce());
  await page.screenshot({ path: path.join(out, file), timeout: 120000 });
  return `saved ${file}`;
}
const shots = [];
shots.push(await hoverShot('vintage_and_village_shops', 'wallys', 'tooltip_wallys.png'));
shots.push(await hoverShot('civic_landmarks', 'post_office', 'pinned_post_office.png', true));
await page.keyboard.press('Escape');
await page.evaluate(() => window.__viewer.viewer.renderOnce());
await page.screenshot({ path: path.join(out, 'map_folded.png'), timeout: 120000 });
await page.click('#map-fold');
await page.waitForTimeout(400);
await page.evaluate(() => window.__viewer.viewer.renderOnce());
await page.screenshot({ path: path.join(out, 'map_open_screen.png'), timeout: 120000 });
await page.locator('#map').screenshot({ path: path.join(out, 'map_open.png') });
await page.keyboard.press('Escape');
shots.push(`map folds again after Escape: ${await page.evaluate(() => document.querySelector('#map').hidden && !document.querySelector('#map-fold').hidden)}`);
await writeFile(path.join(out, 'guide-test.json'), JSON.stringify({ report, shots, logs }, null, 2));
console.log(JSON.stringify({ report, shots, errors: logs.filter((l) => /error|warn/i.test(l)) }, null, 2));
await browser.close();
