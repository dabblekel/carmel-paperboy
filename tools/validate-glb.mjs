// Validate each model's GLB with the Khronos glTF validator and check it against its manifest.
// Usage: npm run validate            (all models in public/models/index.json)
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import validator from 'gltf-validator';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modelsDir = path.join(root, 'public', 'models');
const index = JSON.parse(await readFile(path.join(modelsDir, 'index.json'), 'utf8'));
let failed = false;

for (const entry of index.models) {
  const dir = path.join(modelsDir, entry.id);
  const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
  const bytes = new Uint8Array(await readFile(path.join(dir, manifest.asset)));
  const report = await validator.validateBytes(bytes, { maxIssues: 50, format: 'glb' });
  const { numErrors, numWarnings } = report.issues;

  // Read the GLB JSON chunk to cross-check names the manifest relies on.
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const jsonLength = view.getUint32(12, true);
  const gltf = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)));
  const names = new Set((gltf.nodes ?? []).map((n) => n.name));
  const required = [manifest.spawn?.node, manifest.character?.node, manifest.character?.rig,
    ...(manifest.landmarks ?? []).flatMap((l) => [l.node, l.targetNode])].filter(Boolean);
  const missing = required.filter((n) => !names.has(n));
  const clips = new Set((gltf.animations ?? []).map((a) => a.name));
  const missingClips = (manifest.character?.clips ?? []).map((c) => c.name).filter((c) => !clips.has(c));

  console.log(`\n${entry.id}: ${(bytes.length / 1e6).toFixed(1)} MB, ${gltf.nodes?.length ?? 0} nodes, ` +
    `${gltf.meshes?.length ?? 0} meshes, ${gltf.materials?.length ?? 0} materials, ` +
    `${gltf.animations?.length ?? 0} animations`);
  console.log(`  validator: ${numErrors} errors, ${numWarnings} warnings`);
  for (const m of report.issues.messages.filter((m) => m.severity <= 1).slice(0, 12)) {
    console.log(`   - [${m.severity === 0 ? 'error' : 'warning'}] ${m.code}: ${m.message} (${m.pointer ?? ''})`);
  }
  console.log(`  manifest nodes missing: ${missing.length ? missing.join(', ') : 'none'}`);
  console.log(`  manifest clips missing: ${missingClips.length ? missingClips.join(', ') : 'none'}`);
  if (numErrors || missing.length || missingClips.length) failed = true;
}
process.exit(failed ? 1 : 0);
