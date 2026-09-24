// Browser check for the resident greetings, letter cards and phone booth transition.
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
  const readyError = await page.evaluate(() => window.__viewer.error);
  if (readyError) throw new Error(readyError);

  const place = (where, id, metres = 1) => page.evaluate(({ where, id, metres }) => {
    const { viewer, guide } = window.__viewer;
    const w = viewer.walker;
    const V = w.position.constructor;
    let point, look;
    if (where === 'door') {
      const door = guide.picker.targets.find((target) => target.id === id).door;
      point = door.base.clone().addScaledVector(door.out, metres);
      look = door.out.clone().negate();
    } else {
      const person = guide.greetings.find((greeting) => greeting.node.userData?.name === id);
      if (!person) throw new Error(`No greeting character ${id}`);
      const resident = person.node.getWorldPosition(new V());
      const up = resident.clone().normalize();
      const tangent = new V(0, 0, -1).addScaledVector(up, up.z).normalize();
      point = resident.clone().addScaledVector(tangent, metres);
      look = resident.clone().sub(point);
    }
    const n = point.clone().normalize();
    w.position.copy(w.groundPoint(n) ?? point);
    w.n.copy(w.position).normalize();
    w.facing.copy(look).addScaledVector(w.n, -look.dot(w.n)).normalize();
    w.camHeading.copy(w.facing);
    w.updateCamera(0, true);
    viewer.renderOnce();
    return {
      card: guide.pinned,
      greeting: document.querySelector('#greeting-bubble').hidden ? null : document.querySelector('#greeting-bubble').textContent,
      icon: document.querySelector('#letter-icon svg') !== null,
      paragraphs: document.querySelectorAll('.letter-copy p').length,
      phoneButton: !document.querySelector('#enter-phone-booth').hidden,
    };
  }, { where, id, metres });

  const wally = await place('door', 'wallys', 1);
  assert.equal(wally.card, 'wallys');
  assert.ok(wally.icon && wally.paragraphs >= 2, 'Wally’s letter is missing its paragraphs or drawing');
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'docs/step4/wally-letter.png' });

  for (const [node, line] of [
    ['V2 • Resident 01', 'Hi!'],
    ['V2 • Resident 03', 'Hi!'],
    ['V2 • Resident 04', 'What drink should I get?'],
  ]) {
    const state = await place('resident', node, 1.1);
    assert.equal(state.greeting, line, `Wrong greeting for ${node}`);
    if (node === 'V2 • Resident 04') {
      await page.evaluate(() => {
        const { viewer } = window.__viewer;
        for (let i = 0; i < 75; i++) {
          viewer.walker.update(1 / 30);
          for (const frame of viewer.onFrame) frame(1 / 30);
        }
        viewer.renderOnce();
      });
      await page.screenshot({ path: 'docs/step4/cafe-greeting.png' });
    }
  }

  const phone = await place('door', 'phone_booth', 1.3);
  assert.equal(phone.card, 'phone_booth');
  assert.equal(phone.phoneButton, true, 'The booth entry button is missing');
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'docs/step4/phone-booth-letter.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { window.__viewer.viewer.resize(); window.__viewer.viewer.renderOnce(); });
  await page.screenshot({ path: 'docs/step4/phone-booth-letter-narrow.png' });
  await page.getByRole('button', { name: 'enter phone booth?' }).click();
  assert.equal(await page.locator('#polling-loading').isVisible(), true);
  assert.equal(await page.locator('#polling-loading p').innerText(), 'Polling Booth Loading....');
  assert.equal(await page.evaluate(() => window.__viewer.viewer.walker.enabled), false);
  await page.screenshot({ path: 'docs/step4/polling-loading.png' });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#polling-loading').isVisible(), false);
  assert.equal(await page.evaluate(() => window.__viewer.viewer.walker.enabled), true);
  assert.deepEqual(errors, []);
  console.log('Letter card, three resident greetings, phone booth button, and loading screen: passed');
} finally {
  await browser.close();
}
