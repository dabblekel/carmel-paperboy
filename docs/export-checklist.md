# Export checklist (any model)

Carmel is the worked example; its script is `exports/carmel/prepare_export.py`.

## In Blender, before exporting

- [ ] The editable file is saved. Walk mode is off (its temporary display chunks are gone).
- [ ] Work from a **copy** of the file (`…_Export_Source_Snapshot.blend`), run in background Blender.
- [ ] Export only what ships: visible, renderable geometry and one character with its rig.
      Hidden older versions, the duplicate walk-mode courier, cameras, lights, and scripts are left out.
- [ ] Text and curve objects become meshes, so signs stay readable without fonts.
- [ ] Materials are plain Principled colours. Procedural shaders are baked
      (Carmel's ocean depth gradient becomes vertex colours). Lantern glow keeps its emission.
- [ ] Important groups get a stable `entity_id` custom property (`wallys`, `phone_booth`,
      `cottage_02` …). IDs are properties, so they survive renaming objects.
- [ ] Each landmark gets a `target_<id>` marker with its bounds (for hover cards later).
- [ ] Every mesh gets a `collision_role` (`ground`, `solid`, `none`, `player`) as data.
      The existing `carmel_walk_passable` flag feeds `none`.
- [ ] The character has in-place **Idle** and **Walk** clips on the rig (no travel baked in).
- [ ] Record scale, world centre, spawn position and facing in the manifest, converted to glTF axes:
      Blender (x, y, z) → glTF (x, z, −y). A `spawn_courier` node is exported to check this.
- [ ] Presentation cameras become named `viewpoints` for side-by-side comparison.

## Export options

File → Export → glTF 2.0, preset **Playable Worlds GLB** (saved by the script), with the export
collection selected. The exact options are also in `export_settings.json`:
GLB, selected objects only, +Y up, custom properties as extras, NLA tracks as animations,
skinning on, cameras and lights off, modifiers not applied (only the armature modifier exists).

## After exporting

- [ ] `npm run validate` → 0 errors; all manifest nodes and clips present.
- [ ] Open the viewer with `?debug`: the axis check reads **OK** and the red spawn marker sits on
      the GLB spawn axes.
- [ ] Compare each named view against the Blender reference render (`npm run baseline`).
- [ ] Check signs, water colour, foliage colours, character shading, and upright landmarks.
