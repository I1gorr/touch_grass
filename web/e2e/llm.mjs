// The language-model path in a real browser: download Gemma through Settings, then start a walk so the model writes
// the stop descriptions. Whatever it answers, the app must show a sensible blurb, and the model must have actually run.
// Downloads hundreds of MB, so it is not part of the quick suite. Default model: the small one (same code path).
//   node e2e/llm.mjs [url]     LLM_MODEL=onnx-community/gemma-3-1b-it-ONNX for the recommended model
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const URL_ = process.argv[2] ?? 'http://127.0.0.1:4174/';
const MODEL = process.env.LLM_MODEL ?? 'onnx-community/gemma-3-270m-it-ONNX';
mkdirSync(new URL('../shots/', import.meta.url), { recursive: true });
const shot = (page, name) => page.screenshot({ path: new URL(`../shots/${name}.png`, import.meta.url).pathname });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'allow' });
await context.addInitScript((model) => {
  if (!localStorage.getItem('touch_grass.settings')) {
    localStorage.setItem('touch_grass.settings', JSON.stringify({ version: 1, fakeQuest: true, sttMode: 'fake', llmMode: 'device', llmModel: model }));
  }
}, MODEL);
const page = await context.newPage();
const problems = [];
const mlLogs = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.text().includes('[ml]')) mlLogs.push(m.text().replace(/\s+/g, ' ').slice(0, 260));
  else if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
});

const t0 = Date.now();
const ok = (msg) => console.log(`ok   ${msg}  (+${Math.round((Date.now() - t0) / 1000)}s)`);
try {
  await page.goto(URL_ + '#/settings');
  await page.getByText('On-device models').waitFor();
  if (!(await page.evaluate(async () => !!navigator.gpu && !!(await navigator.gpu.requestAdapter().catch(() => null))))) {
    // The language model needs WebGPU. Check the app says so instead of offering a useless download.
    await page.getByText(/no WebGPU/).waitFor({ timeout: 10000 });
    console.log('SKIP no WebGPU in this browser: verified that Settings explains it and offers no language-model download.');
    await browser.close();
    process.exit(0);
  }
  // The language model is the second "Download" button (the first is the speech model).
  await page.getByRole('button', { name: 'Download' }).nth(1).click();
  await page.getByText(/Downloading…|Starting the download/).first().waitFor({ timeout: 30000 });
  ok('language model download started');
  await page.getByText('On this phone. Works offline.').first().waitFor({ timeout: 25 * 60_000 });
  ok('language model downloaded');

  await page.goto(URL_ + '#/');
  await page.getByRole('button', { name: 'Prepare quest' }).click();
  await page.getByText(/stops · loop back/).waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'Start this walk' }).click();
  await page.getByText(/Stop 1 of/).waitFor({ timeout: 10 * 60_000 }); // the model writes one blurb per stop
  ok('the walk started with stop descriptions written by the on-device model path');
  const blurb = await page.locator('.card.tint p').first().innerText();
  console.log(`     blurb: ${JSON.stringify(blurb)}`);
  await shot(page, 'l1-walk');
  if (blurb.trim().length < 10) throw new Error('no stop description was shown');
  const loadFailures = mlLogs.filter((l) => /could not load|not available|unavailable/i.test(l));
  if (loadFailures.length) throw new Error(`the model failed to load: ${loadFailures[0]}`);
  ok('the model loaded and ran (any rejected answers were replaced by the pre-written text)');
} catch (e) {
  console.log(`FAIL ${e.message.split('\n')[0]}`);
  problems.push(e.message.split('\n')[0]);
  await shot(page, 'l-fail').catch(() => {});
}
console.log('[ml] log lines:\n  ' + (mlLogs.slice(0, 12).join('\n  ') || '(none)'));
console.log(problems.length ? `\n${problems.length} problem(s):\n- ${problems.join('\n- ')}` : '\nNo console errors or page errors.');
await browser.close();
process.exit(problems.length ? 1 : 0);
