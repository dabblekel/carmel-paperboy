// Checks Wally's doorway trigger and the nearby resident conversation in the built viewer.
// Run with VIEWER_URL=http://127.0.0.1:8765/ node tools/test-wally-conversation.mjs.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${process.env.VIEWER_URL ?? 'http://127.0.0.1:8765/'}?still&nointro`);
  await page.waitForFunction(() => window.__viewer?.ready || window.__viewer?.error, null, { timeout: 120000 });
  const result = await page.evaluate(() => {
    const { viewer, guide, error } = window.__viewer;
    if (error) throw new Error(error);
    const w = viewer.walker;
    const door = guide.picker.targets.find((target) => target.id === 'wallys').door;
    const V = w.position.constructor;
    const woman = guide.conversationNpc?.getWorldPosition(new V());
    if (!woman) throw new Error('The yellow-shirt resident was not found in the exported world');
    const at = (metres, faceDoor) => {
      const wanted = door.base.clone().addScaledVector(door.out, metres);
      const n = wanted.clone().normalize();
      w.position.copy(w.groundPoint(n) ?? wanted);
      w.n.copy(w.position).normalize();
      w.facing.copy(door.out).multiplyScalar(faceDoor ? -1 : 1);
      w.facing.addScaledVector(w.n, -w.facing.dot(w.n)).normalize();
      w.camHeading.copy(w.facing);
      w.updateCamera(0, true);
      viewer.renderOnce();
      const offset = w.position.clone().sub(door.base);
      return {
        along: offset.dot(door.out),
        fromWoman: w.position.distanceTo(woman),
        card: guide.pinned,
        visited: guide.visited.has('wallys'),
        womanSays: !document.querySelector('#conversation-npc').hidden,
        boyReplies: !document.querySelector('#conversation-reply').hidden,
      };
    };
    return {
      before: at(2.3, true),
      door: at(1.0, true),
      woman: at(2.3, false),
      away: at(7.0, false),
    };
  });
  console.log(JSON.stringify(result, null, 2));
  assert.equal(result.before.card, null, 'Wally’s card opened near the woman before reaching the door');
  assert.equal(result.before.womanSays, false, 'The conversation appeared before visiting Wally’s');
  assert.equal(result.door.card, 'wallys', 'Wally’s card did not open at the door');
  assert.equal(result.door.visited, true, 'Wally’s was not marked visited');
  assert.equal(result.woman.card, null, 'Wally’s card stayed open by the woman');
  assert.equal(result.woman.womanSays, true, 'The woman did not speak after Wally’s visit');
  assert.equal(result.woman.boyReplies, true, 'The paperboy did not reply');
  assert.equal(result.away.womanSays, false, 'The woman’s bubble stayed open after walking away');
  assert.equal(result.away.boyReplies, false, 'The paperboy’s bubble stayed open after walking away');
  assert.deepEqual(errors, [], 'Browser errors occurred');
  await page.evaluate(() => {
    const { viewer, guide } = window.__viewer;
    const w = viewer.walker;
    const door = guide.picker.targets.find((target) => target.id === 'wallys').door;
    const wanted = door.base.clone().addScaledVector(door.out, 2.3);
    w.n.copy(wanted).normalize();
    w.position.copy(w.groundPoint(w.n) ?? wanted);
    w.n.copy(w.position).normalize();
    w.facing.copy(door.out).addScaledVector(w.n, -door.out.dot(w.n)).normalize();
    w.camHeading.copy(w.facing);
    w.updateCamera(0, true);
    viewer.renderOnce();
  });
  await page.screenshot({ path: 'docs/step4/wally-conversation.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    window.__viewer.viewer.resize();
    window.__viewer.viewer.renderOnce();
  });
  await page.screenshot({ path: 'docs/step4/wally-conversation-narrow.png' });
} finally {
  await browser.close();
}
