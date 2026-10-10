// End-to-end smoke test in a real (headless) Chromium at phone size. Run against `npm run preview`:
//   node e2e/smoke.mjs [https://localhost:4173/]
// Uses Chromium's fake microphone/camera so the real capture code runs, and the bundled demo map (no network).
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const URL_ = process.argv[2] ?? 'https://localhost:4173/';
const EXEC = process.env.CHROMIUM ?? '/usr/bin/chromium';
mkdirSync(new URL('../shots/', import.meta.url), { recursive: true });
const shot = (page, name) => page.screenshot({ path: new URL(`../shots/${name}.png`, import.meta.url).pathname });

const browser = await chromium.launch({
  executablePath: EXEC,
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--no-sandbox'],
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  ignoreHTTPSErrors: true,
  permissions: ['microphone', 'camera'],
  serviceWorkers: 'block',
});
// Sample map only, canned speech and text: nothing needs the network or a model.
await context.addInitScript(() => {
  if (!localStorage.getItem('touch_grass.settings')) {
    localStorage.setItem('touch_grass.settings', JSON.stringify({ version: 1, fakeQuest: true, sttMode: 'fake', llmMode: 'fake', fakeDevices: false }));
  }
});
const page = await context.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => ['error'].includes(m.type()) && problems.push(`console.${m.type()}: ${m.text()}`));

const step = async (name, fn) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}: ${e.message.split('\n')[0]}`);
    await shot(page, `fail-${name.replace(/\W+/g, '-')}`).catch(() => {});
    problems.push(`${name}: ${e.message.split('\n')[0]}`);
    throw e;
  }
};

try {
  await step('home loads', async () => {
    await page.goto(URL_);
    await page.getByRole('heading', { name: 'Touch Grass' }).waitFor();
    await page.getByText('Prepare quest').waitFor();
    await page.getByText('No walks yet.').waitFor();
    await shot(page, '1-home');
  });

  await step('route review offers street loops', async () => {
    await page.getByRole('button', { name: 'Prepare quest' }).click();
    await page.getByText(/stops · loop back to the start/).waitFor({ timeout: 30000 });
    await page.locator('.chip.choice').first().waitFor();
    if ((await page.locator('.chip.choice').count()) < 1) throw new Error('no route options');
    await shot(page, '2-routes');
  });

  await step('start a walk', async () => {
    await page.getByRole('button', { name: 'Start this walk' }).click();
    await page.getByText(/Stop 1 of/).waitFor({ timeout: 30000 });
    await page.getByText('Tap the mic and answer the prompt out loud.').waitFor();
    await shot(page, '3-walk');
  });

  await step('record a note with the (fake) microphone', async () => {
    await page.getByRole('button', { name: 'Record' }).click();
    await page.getByRole('button', { name: 'Stop recording' }).waitFor();
    await shot(page, '4-recording');
    await page.waitForTimeout(1500);
    await page.getByRole('button', { name: 'Stop recording' }).click();
    // The canned transcript appears once the (fake) engines finish: cleaned text first shows as the raw text.
    await page.getByText(/light here is really nice/i).first().waitFor({ timeout: 20000 });
    await page.waitForFunction(() => document.body.innerText.includes('So the light here is really nice'), null, { timeout: 20000 });
    await shot(page, '5-note');
  });

  await step('take the walk photo with the (fake) camera', async () => {
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByRole('button', { name: 'Take this walk’s photo' }).click(),
    ]);
    // A real JPEG, made in the page so the test needs no fixture file.
    const bytes = await page.evaluate(async () => {
      const c = document.createElement('canvas');
      c.width = 640; c.height = 480;
      const g = c.getContext('2d');
      g.fillStyle = '#2f6b3f'; g.fillRect(0, 0, 640, 480);
      g.fillStyle = '#edf5ec'; g.beginPath(); g.arc(320, 240, 120, 0, Math.PI * 2); g.fill();
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    });
    await chooser.setFiles({ name: 'grass.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(bytes) });
    await page.locator('img.photo').first().waitFor({ timeout: 20000 });
    await shot(page, '6-photo');
  });

  await step('walk through every stop and finish', async () => {
    for (let i = 0; i < 12; i++) {
      const next = page.getByRole('button', { name: 'Next stop' });
      if (!(await next.isVisible().catch(() => false))) break;
      await next.click();
      await page.waitForTimeout(150);
    }
    await page.getByRole('button', { name: 'Finish walk' }).click();
    await page.getByRole('heading', { name: 'Walk journal' }).waitFor({ timeout: 20000 });
    await page.getByText(/light here is really nice/i).first().waitFor();
    await page.locator('img.photo').first().waitFor();
    await shot(page, '7-journal');
  });

  await step('the walk is listed as done on the home screen', async () => {
    await page.goBack().catch(() => {});
    await page.goto(URL_ + '#/');
    await page.getByText('Done', { exact: true }).waitFor();
    await shot(page, '8-home-after');
  });

  await step('settings shows the on-device models section', async () => {
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByText('On-device models').waitFor();
    await shot(page, '9-settings');
  });

  await step('data survives a reload', async () => {
    await page.goto(URL_ + '#/');
    await page.reload();
    await page.getByText('Done', { exact: true }).waitFor();
  });
} catch {
  /* reported below */
}

console.log(problems.length ? `\n${problems.length} problem(s):\n- ${problems.join('\n- ')}` : '\nNo console errors or page errors.');
await browser.close();
process.exit(problems.length ? 1 : 0);
