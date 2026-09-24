import './styles.css';
import { WorldViewer } from './viewer';
import { Guide, type Description } from './guide';
import type { GuideConfig } from './map';
import type { ModelIndex } from './types';

const params = new URLSearchParams(window.location.search);
const debug = params.has('debug');
const capture = params.has('capture'); // hides the interface for baseline screenshots
const still = params.has('still'); // keeps the interface but stops the render loop (tests on slow machines)

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const stage = $('#stage');
const loading = $('#loading');
const bar = $<HTMLDivElement>('#loading-bar');
const loadingText = $('#loading-text');
const errorBox = $('#error');
const errorText = $('#error-text');
const viewsEl = $('#views');
const debugEl = $('#debug');

if (capture) document.body.classList.add('capture');

const viewer = new WorldViewer(stage);
(window as unknown as { __viewer: unknown }).__viewer = { viewer, ready: false, error: null as string | null };
const hook = (window as unknown as { __viewer: { ready: boolean; error: string | null; guide?: Guide } }).__viewer;

async function start(): Promise<void> {
  loading.hidden = false;
  errorBox.hidden = true;
  bar.style.width = '0%';
  try {
    const index = (await (await fetch('models/index.json')).json()) as ModelIndex;
    const id = params.get('model') ?? index.default;
    const entry = index.models.find((m) => m.id === id);
    if (!entry) throw new Error(`There is no model called “${id}”. Available: ${index.models.map((m) => m.id).join(', ')}.`);
    document.title = `${entry.title} · Playable Worlds`;
    loadingText.textContent = `Loading ${entry.title}…`;

    await viewer.load(entry.manifest, (f) => {
      if (f === null) {
        bar.classList.add('indeterminate');
      } else {
        bar.classList.remove('indeterminate');
        bar.style.width = `${Math.round(f * 100)}%`;
        loadingText.textContent = `Loading ${entry.title}… ${Math.round(f * 100)}%`;
      }
    });
    if (viewer.mode === 'orbit') {
      buildViewButtons();
      $('#view-bar').hidden = false;
    } else {
      $('#walk-bar').hidden = false;
      $('#look-ahead').addEventListener('click', () => viewer.walker?.lookAhead());
    }
    await startGuide(entry.manifest);
    const view = params.get('view');
    if (view) viewer.setView(view, false);
    if (debug) startDebug();
    if (capture || still) viewer.pause(); // the test tools call renderOnce() themselves
    loading.hidden = true;
    hook.ready = true;
  } catch (err) {
    loading.hidden = true;
    errorText.textContent = err instanceof Error ? err.message : String(err);
    errorBox.hidden = false;
    hook.error = errorText.textContent;
    console.error(err);
  }
}

/** Tooltips and the route map, when the model folder has guide.json (and descriptions.json). */
async function startGuide(manifestUrl: string): Promise<void> {
  const base = new URL('.', new URL(manifestUrl, window.location.href));
  const get = async <T,>(name: string): Promise<T | null> => {
    try {
      const r = await fetch(new URL(name, base));
      return r.ok ? ((await r.json()) as T) : null;
    } catch {
      return null;
    }
  };
  const [config, text] = await Promise.all([get<GuideConfig>('guide.json'), get<Record<string, Description>>('descriptions.json')]);
  if (!config) return;
  if (!text) console.warn('[guide] descriptions.json is missing or not valid JSON; tooltips will be empty.');
  hook.guide = new Guide(viewer, config, text ?? {});
}

function buildViewButtons(): void {
  viewsEl.replaceChildren();
  for (const v of viewer.views) {
    if (v.id === 'home') continue;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = v.label;
    b.addEventListener('click', () => viewer.setView(v.id));
    viewsEl.append(b);
  }
}

function startDebug(): void {
  viewer.showDebugMarkers(true);
  debugEl.hidden = false;
  const a = viewer.axisCheck;
  const render = () => {
    const s = viewer.stats();
    debugEl.textContent =
      `${s.fps.toFixed(0)} fps · ${s.drawCalls} draw calls · ${(s.triangles / 1000).toFixed(0)}k tris · ` +
      `${s.meshes} drawn objects${viewer.batchInfo ? ` (${viewer.batchInfo.sourceMeshes} meshes merged into ${viewer.batchInfo.chunks})` : ''} · loaded in ${s.loadSeconds.toFixed(1)} s · resolution ${viewer.resolution.pixelRatio}× of ${viewer.resolution.max}×\n` +
      `Axis check: ${a?.ok ? 'OK' : 'CHECK'} (${a?.note ?? 'not run'})` +
      (viewer.walker ? `\nWalking: ${viewer.walker.message || 'ok'} · collision ${viewer.walker.stats.ground.toLocaleString()} ground / ${viewer.walker.stats.obstacles.toLocaleString()} obstacle triangles` : '');
  };
  render();
  setInterval(render, 500);
}

$('#reset').addEventListener('click', () => viewer.setView('home'));
$('#retry').addEventListener('click', () => void start());
window.addEventListener('keydown', (e) => {
  if (e.key === 'Home' && viewer.mode === 'orbit' && !(e.target instanceof HTMLInputElement)) viewer.setView('home');
});

void start();
