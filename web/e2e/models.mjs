// Real on-device speech recognition in a real browser: download Whisper through the Settings screen, go offline,
// then transcribe a recording of real speech. Downloads ~45 MB from huggingface.co, so it is not part of the quick suite.
//   SPEECH_WAV=/path/to/16-bit-speech.wav node e2e/models.mjs [https://localhost:4173/]
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const URL_ = process.argv[2] ?? 'https://localhost:4173/';
const WAV = process.env.SPEECH_WAV;
if (!WAV) throw new Error('Set SPEECH_WAV to a 16-bit PCM .wav file with clear English speech.');
const MODEL = process.env.STT_MODEL ?? 'onnx-community/whisper-tiny.en';
mkdirSync(new URL('../shots/', import.meta.url), { recursive: true });
const shot = (page, name) => page.screenshot({ path: new URL(`../shots/${name}.png`, import.meta.url).pathname });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium',
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${WAV}`, '--no-sandbox'],
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true,
  permissions: ['microphone', 'camera'], serviceWorkers: 'allow', // the service worker serves the app and the demo map offline
});
await context.addInitScript((model) => {
  if (!localStorage.getItem('touch_grass.settings')) {
    localStorage.setItem('touch_grass.settings', JSON.stringify({ version: 1, fakeQuest: true, sttMode: 'auto', llmMode: 'fallback', sttModel: model }));
  }
}, MODEL);
const page = await context.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && problems.push(`console.error: ${m.text()}`));
const requested = [];
page.on('request', (r) => /huggingface|jsdelivr|\.wasm/.test(r.url()) && requested.push(r.url().replace(/\?.*/, '')));

const t0 = Date.now();
const ok = (m) => console.log(`ok   ${m}  (+${Math.round((Date.now() - t0) / 1000)}s)`);
try {
  await page.goto(URL_ + '#/');
  await page.getByText('Voice notes need a speech model').waitFor();
  ok('home explains that voice notes need a speech model');

  await page.goto(URL_ + '#/settings');
  await page.getByText('On-device models').waitFor();
  await page.getByRole('button', { name: 'Download' }).first().click();
  await page.getByText(/Downloading…/).waitFor({ timeout: 20000 });
  ok('download started and shows progress');
  await shot(page, 'm1-downloading');
  await page.getByText('On this phone. Works offline.').first().waitFor({ timeout: 8 * 60_000 });
  ok('speech model downloaded');
  await shot(page, 'm2-ready');

  // The app shell and demo map are cached by the service worker once it is active.
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 15000 });
  ok('the service worker controls the page');
  await page.waitForTimeout(1500);

  // From here on there is no network: everything must come from this phone.
  await context.setOffline(true);
  ok('went offline');

  await page.goto(URL_ + '#/'); // an SPA hash change: no network needed
  await page.getByText('Voice notes need a speech model').waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
  await page.getByRole('button', { name: 'Prepare quest' }).click();
  await page.getByText(/stops · loop back/).waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'Start this walk' }).click();
  await page.getByText(/Stop 1 of/).waitFor({ timeout: 30000 });
  ok('planned and started a walk offline');

  await page.getByRole('button', { name: 'Record' }).click();
  await page.getByRole('button', { name: 'Stop recording' }).waitFor();
  await page.waitForTimeout(Number(process.env.RECORD_MS ?? 14000));
  await page.getByRole('button', { name: 'Stop recording' }).click();
  await page.getByText('Transcribing…').waitFor({ timeout: 20000 });
  ok('recording submitted, transcribing on the phone');
  await shot(page, 'm3-transcribing');
  await page.waitForFunction(() => !document.body.innerText.includes('Transcribing…') && !document.body.innerText.includes('Cleaning up…'), null, { timeout: 5 * 60_000 });
  const text = await page.locator('.entry-text').first().innerText();
  console.log(`     transcript: ${JSON.stringify(text)}`);
  await shot(page, 'm4-transcript');
  if (!/americans|country|fellow|ask/i.test(text)) throw new Error('the transcript does not look like the recorded speech');
  ok('real speech was transcribed on-device, offline');
} catch (e) {
  console.log(`FAIL ${e.message.split('\n')[0]}`);
  problems.push(e.message.split('\n')[0]);
  await shot(page, 'm-fail').catch(() => {});
}
console.log('network requests of interest:\n  ' + [...new Set(requested)].slice(0, 25).join('\n  '));
console.log(problems.length ? `\n${problems.length} problem(s):\n- ${problems.join('\n- ')}` : '\nNo console errors or page errors.');
await browser.close();
process.exit(problems.length ? 1 : 0);
