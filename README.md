# Playable Worlds

A reusable browser viewer for the Paperboy worlds. Blender stays the place to make and edit each
world; the export script turns a world into a **GLB** plus a small **manifest**, and this app shows
it in any desktop browser. Nothing here needs Blender installed.

Status: the playable route is built. The page opens on the route map, full page;
closing it (× , Escape or **Start the route**) folds it into the corner and he's among the
cottages; you walk him freely around the planet. Walking up to a town building or the phone
booth shows its card, and the folded map in the corner shows the suggested route. The comparison
against Blender and the laptop frame rates are in `docs/visual-baseline/`.

This folder is also the local Git repository for the website. Its Pages workflow builds and publishes
`dist/` whenever changes are pushed to `main`. The Blender source and older experiments stay outside
this repository in the larger Paperboy workspace.

## Run it

**Quickest:** double-click **Open Viewer.command**. It serves the ready-built `dist/` folder with
the Python that comes with macOS and opens it in your browser. Close its Terminal window to stop.
(The first time, macOS may ask you to confirm: right-click the file → Open.)

**To change the code**, you need [Node.js](https://nodejs.org) 20.19 or newer:

```bash
cd "Paperboy Presentation/playable-worlds"
npm install          # first time only
npm run dev          # prints a local address such as http://localhost:5173 — open it
```

After changing code, `npm run build` refreshes `dist/` for the launcher.
Double-clicking `index.html` will not work: browsers refuse to load the model from a file opened
that way.

## Controls

| Key | Action |
| --- | --- |
| ↑ / W | Walk away from the camera |
| ↓ / S | Turn towards the camera and walk; the camera backs up to keep its distance |
| ← → / A D | Walk left or right on screen |
| Shift | Run |
| Mouse towards the left or right edge | Gently look that way |
| Space, C or **Look ahead** | Swing the camera round behind him (slowly, with easing) |
| R | Back to the start |

On a phone or touchscreen, drag the round joystick in the lower-left corner to walk in any
direction. Moving the thumb only a little makes him walk slowly; releasing it stops him. The
**Look ahead** button sits just above it, and the folded route map stays in the lower-right corner.

The camera stays about 10 m behind and 13 m above him, as in Blender walk mode. When scenery
hides him it rises gently to a more overhead angle, and settles back once the view is clear.
The collision rules match Blender: houses and tree trunks block him; flowers, rocks, low planting
and bridge rails don't; he can't climb steep ledges; the ocean is the edge of the world. Blocked
movement slides along walls rather than stopping dead.

On a slow frame rate the view draws at a slightly lower resolution (Retina screens start at 2×,
never below 1×) and steps back up when there's headroom; `?fixedres` turns this off.

Address options for checking things: `?debug` shows frame rate, draw calls, resolution and walking status;
`?orbit` switches to the free inspection camera with the Blender presentation views (used by the
screenshot tools); `?nobatch` draws every object separately (slow).

## Tooltips and the route map

- **Wording:** edit `public/models/carmel/descriptions.json`, then rebuild the viewer. Each entry
  has a `title` and `description`; `\n\n` in the description starts a new paragraph in the
  letter-style card. The card drawings are in `src/lettericons.ts`.
- **Which buildings have tooltips, and the route order:** `public/models/carmel/guide.json`.
  `tooltips` lists landmark IDs; `route` lists the map stops in order (`start` is the
  courier's starting point). Available IDs are in `manifest.json` under `landmarks`.
- `doorRange` in `guide.json` can give a building a tighter walk-up area. Wally's card now opens
  at its door, past the yellow-shirt resident. After that stop is visited, approaching her shows
  a two-line exchange in speech bubbles; both close when the paperboy leaves. Its character
  node and wording are in `conversation` in the same file. `greetings` gives the other nearby
  residents short speech bubbles.
- While walking, a building's card appears when he stands at its front door and faces it (for
  City Hall, the foot of its steps), and closes as he walks away. The card sits beside the door,
  never over him. The door is found by name in the model (`Door`, `Entry divider`, the booth's
  door panels). (In `?orbit` mode, pointing at a building shows its card instead.)
- Each route stop gets a yellow star stamp on the map the first time its card opens.
- At the phone booth, the card has **enter phone booth?**. Selecting it opens the Polling Booth
  Loading screen; click the screen or press Escape to return to the route.
- **First screen:** the route map fills the page, and he can't move until it's closed. After
  that the folded map in the corner opens the small panel as usual. `?nointro` skips it.
- **Route map:** the folded map in the bottom-right corner opens the stops in order as icons
  on a curving dashed line; × or Escape folds it again. Icons per stop are set under `icons` in
  `guide.json` (home, shop, hall, post, coffee, phone).

## Update the Carmel model

1. Edit `../blender/carmel_v3/Carmel_Walkable_v4.blend` as usual and save.
2. Copy it over `../exports/carmel/Carmel_Export_Source_Snapshot.blend`.
3. From `../exports/carmel/`, run the export in background Blender (it never touches the editable file):
   ```bash
   /Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup \
     Carmel_Export_Source_Snapshot.blend --python-exit-code 1 --python prepare_export.py
   ```
4. Copy `world.glb` and `manifest.json` into `public/models/carmel/` (and `dist/models/carmel/`).
   Don't copy the template: `descriptions.json` and `guide.json` here hold the tooltip text and map route.
5. `npm run validate` checks the GLB against the glTF specification and the manifest.
6. `npm run baseline` (with `npx vite preview --port 4173` running) re-captures the comparison
   screenshots in `docs/visual-baseline/`.

## Layout

```text
playable-worlds/
  index.html, src/          shared viewer: loading, camera, lighting, UI
    viewer.ts               loads a manifest + GLB, orbit camera, named views, axis check
    batching.ts             merges static scenery into a few hundred chunks for speed
    lighting.ts             lighting presets (sunny_warm for Carmel)
    walker.ts               walking: controls, collision, follow camera, walk-up distance
    guide.ts, landmarks.ts  building cards (walk-up, or hover in ?orbit), landmark picking
    routemap.ts, map.ts     the route map (icons and curve) and guide.json settings
  public/models/
    index.json              list of available models
    carmel/                 world.glb, manifest.json, descriptions.json, guide.json
  tools/
    validate-glb.mjs        Khronos glTF validator + manifest cross-check
    capture-baseline.mjs    screenshots from each manifest view
    test-guide.mjs          checks hover tooltips (?orbit) against the true surface under the pointer
    test-walk.mjs           walks the whole route with simulated keys; checks cards, ledges, ocean
  docs/
    export-checklist.md     repeatable steps for any new model
    visual-baseline/        Blender reference renders beside browser captures
```

Dependencies are pinned to exact versions (three 0.186.0, Vite 8.3.0, TypeScript 5.9.3).
