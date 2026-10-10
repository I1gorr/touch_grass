// Speech must work whatever happens to the language model. Real browser, the DEFAULT Whisper model, no WebGPU, and the language
// model forced on (so it fails). Journey: record before any model exists -> note waits -> type one note instead -> download the
// speech model from the walk screen -> the waiting note becomes text -> go offline -> record again -> transcribed on-device.
// Downloads ~80 MB. Needs `npm run preview:http` (service worker) and SPEECH_WAV=/path/to/16-bit-16kHz-speech.wav
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const URL_ = process.argv[2] ?? 'http://127.0.0.1:4174/';
const WAV = process.env.SPEECH_WAV;
if (!WAV) throw new Error('Set SPEECH_WAV to a 16-bit PCM .wav file with clear English speech.');
mkdirSync(new URL('../shots/', import.meta.url), { recursive: true });
const shot = (page, name) => page.screenshot({ path: new URL(`../shots/${name}.png`, import.meta.url).pathname });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${WAV}`],
});
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['microphone'], serviceWorkers: 'allow' });
// Default speech model (Whisper base). Language model forced to on-device: without WebGPU it can never load.
await context.addInitScript(() => {
  if (!localStorage.getItem('touch_grass.settings')) localStorage.setItem('touch_grass.settings', JSON.stringify({ version: 1, fakeQuest: true, sttMode: 'auto', llmMode: 'device' }));
});
const page = await context.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && !/ERR_INTERNET_DISCONNECTED/.test(m.text()) && problems.push(`console.error: ${m.text()}`));
const t0 = Date.now();
const ok = (m) => console.log(`ok   ${m}  (+${Math.round((Date.now() - t0) / 1000)}s)`);
const record = async (ms) => {
  await page.getByRole('button', { name: 'Record' }).click();
  await page.getByRole('button', { name: 'Stop recording' }).waitFor();
  await page.waitForTimeout(ms);
  await page.getByRole('button', { name: 'Stop recording' }).click();
};
const noteTexts = () => page.locator('.entry-text').allInnerTexts();

try {
  await page.goto(URL_);
  await page.getByRole('button', { name: 'Prepare quest' }).click();
  await page.getByText(/stops · loop back/).waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'Start this walk' }).click();
  await page.getByText(/Stop 1 of/).waitFor({ timeout: 60000 });
  const blurb = await page.locator('.card.tint p').first().innerText();
  if (blurb.trim().length < 10) throw new Error('no stop description although the language model is unavailable');
  ok('the language model cannot run, yet the walk starts with a stop description');
  await page.getByText('Voice notes need the speech model').waitFor();
  ok('the walk screen offers the speech model right there');

  // 1. Record with no model: kept, waiting.
  await record(3000);
  await page.getByText('Waiting for the speech model').waitFor({ timeout: 10000 });
  await shot(page, 'sp1-waiting');
  ok('a recording made before the model exists is kept and waits');

  // 2. Type that one instead.
  await page.getByRole('button', { name: 'Type it instead' }).click();
  await page.getByRole('textbox', { name: 'Your note' }).fill('um the bench is is wet');
  await page.getByRole('button', { name: 'Save note' }).click();
  await page.getByText('The bench is wet.').waitFor({ timeout: 10000 });
  await page.getByText('Waiting for the speech model').waitFor({ state: 'detached', timeout: 5000 });
  ok('a note can be typed instead, and is cleaned up like any other');

  // 3. Record a second note that will wait, then download the model from here.
  await record(3000);
  await page.getByText('Waiting for the speech model').waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: /Download speech model/ }).click();
  await page.getByText(/Downloading…|Starting the download/).first().waitFor({ timeout: 30000 });
  ok('download started from the walk screen');
  await shot(page, 'sp2-downloading');
  await page.getByText('Waiting for the speech model').waitFor({ state: 'detached', timeout: 6 * 60_000 });
  ok('the speech model (Whisper base) downloaded and the waiting note was picked up');
  await page.waitForFunction(() => !/Transcribing…|Cleaning up…/.test(document.body.innerText), null, { timeout: 4 * 60_000 });
  const afterDownload = await noteTexts();
  console.log('     notes:', JSON.stringify(afterDownload));
  if (afterDownload.length < 2) throw new Error('the waiting note did not become text');
  await shot(page, 'sp3-transcribed');
  ok('the waiting recording became text');

  // 4. Offline from now on: record again, transcribed on the phone.
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => 0));
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 15000 });
  await page.waitForTimeout(1500);
  await context.setOffline(true);
  ok('went offline');
  await page.getByRole('button', { name: 'Next stop' }).click();
  await page.getByText(/Stop 2 of/).waitFor();
  await record(Number(process.env.RECORD_MS ?? 14000));
  await page.getByText('Transcribing…').waitFor({ timeout: 20000 });
  await page.waitForFunction(() => !/Transcribing…|Cleaning up…/.test(document.body.innerText), null, { timeout: 4 * 60_000 });
  const text = (await noteTexts())[0];
  console.log(`     transcript: ${JSON.stringify(text)}`);
  await shot(page, 'sp4-offline');
  if (!/american|country|fellow|ask/i.test(text)) throw new Error('the transcript does not look like the recorded speech');
  ok('real speech transcribed on-device, offline, with the language model unavailable');
} catch (e) {
  console.log(`FAIL ${e.message.split('\n')[0]}`);
  problems.push(e.message.split('\n')[0]);
  await shot(page, 'sp-fail').catch(() => {});
}
console.log(problems.length ? `\n${problems.length} problem(s):\n- ${problems.join('\n- ')}` : '\nNo console errors or page errors.');
await browser.close();
process.exit(problems.length ? 1 : 0);
