# Visual baseline — Carmel, steps 1–2

`comparison.png` puts each Blender presentation camera (left, Cycles, 900 px) beside the
browser viewer from the same view (right). The individual images are `<view>_blender.png` and
`<view>_browser.png`; `planet_browser.png` and `home_browser.png` show the two viewer-only views.

- Blender renders: `exports/carmel/render_reference.py`, run in background Blender on the
  source snapshot (48 samples, CPU).
- Browser captures: `npm run baseline` (headless Chromium, software rendering, same size).

## What was checked

| Check | Result |
| --- | --- |
| Residential area (Cottage garden) | Same framing, roof tiles, cottage colours, residents |
| Wally's storefront (Vintage and village shops) | Hanging sign readable, rooftop horse, display shirts |
| Beach (Sunny beach) | Blue depth gradient and surf lines, driftwood, pale sand |
| Phone booth | Upright on the shore in both |
| Signs | "Wally's", "City Hall", "United States Post Office", trail signs readable |
| Characters | Rounded hair and faces shade softly; courier stands at the spawn point |
| Autumn foliage | Amber, russet, red and green crowns match |
| Axis check (`?debug`) | Spawn offset 0.0000 m, facing offset 0.00° |

Remaining differences are expected: Cycles adds soft contact shading and bounce light that the
browser approximates with a sky light and fill lights, so creases read slightly lighter.

The four presentation cameras in Blender are **orthographic**. The viewer stays perspective and
reproduces them with a long lens from 92 m back along the same line of sight, which matches the
framing closely and still orbits naturally.

## Performance on the target laptop (Apple M2, Chrome, Retina 2880×1624)

Measured with each frame forced to finish before the next (a conservative method; normal
animation overlaps work and runs faster):

| View | Before merging | After (merged scenery, cached shadows) |
| --- | --- | --- |
| Start | 6 fps, 6,446 draw calls | 26 fps, 325 calls |
| Whole planet | 6 fps, 9,865 calls | 22 fps, 591 calls |
| Sunny beach | 8 fps, 6,053 calls | 38 fps, 138 calls |
| Cottage garden | 5 fps, 5,853 calls | 32 fps, 150 calls |

The viewer merges 5,295 static meshes into 568 chunks at load time (by material and 24 m region)
and draws the sun's shadow map once. The original objects stay in the scene, hidden, with their
IDs, for hover targets (step 3) and collision data (step 4). `?nobatch` shows the unmerged scene.
Load time on the laptop: about 2.7 s from the local server.
