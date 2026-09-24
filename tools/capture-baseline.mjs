// Capture browser screenshots from each manifest viewpoint (the Blender presentation cameras),
// at the same square size as the Blender reference renders, for a visual baseline.
//
//   npm run build && npx vite preview --port 4173 &
//   npm run baseline                       -> docs/visual-baseline/<view>_browser.png
//
// Env: VIEWER_URL (default http://localhost:4173/), MODEL (default carmel), SIZE (default 900),
//      CHROME_PATH (a Chromium/Chrome binary; otherwise uses the installed Google Chrome).
import { chromium } from 'playwright-core';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = process.env.VIEWER_URL ?? 'http://localhost:4173/';
const model = process.env.MODEL ?? 'carmel';
const size = Number(process.env.SIZE ?? 900);
const outDir = path.join(root, 'docs', 'visual-baseline');
await mkdir(outDir, { recursive: true });

const manifest = JSON.parse(await readFile(path.join(root, 'public', 'models', model, 'manifest.json'), 'utf8'));
const views = process.env.VIEWS ? process.env.VIEWS.split(',') : ['planet', 'home', ...(manifest.viewpoints ?? []).map((v) => v.id)];

const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
const log = [];
page.on('console', (m) => log.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => log.push(`[pageerror] ${e.message}`));

const results = [];
for (const view of views) {
  const started = Date.now();
  await page.goto(`${url}?model=${model}&view=${view}&capture&orbit`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__viewer?.ready || window.__viewer?.error, null, { timeout: 180000 });
  const state = await page.evaluate(() => ({ error: window.__viewer.error, axis: window.__viewer.viewer.axisCheck }));
  if (state.error) throw new Error(state.error);
  await page.evaluate(() => window.__viewer.viewer.renderOnce()); // one settled frame
  const file = path.join(outDir, `${view}_browser.png`);
  await page.screenshot({ path: file, timeout: 120000 });
  const stats = await page.evaluate(() => window.__viewer.viewer.stats());
  results.push({ view, file: path.relative(root, file), seconds: (Date.now() - started) / 1000, stats, axis: state.axis });
  console.log(`${view}: ${stats.drawCalls} draw calls, ${(stats.triangles / 1000).toFixed(0)}k triangles`);
}
await writeFile(path.join(outDir, 'capture-report.json'), JSON.stringify({ url, model, size, results, log }, null, 2));
await browser.close();
