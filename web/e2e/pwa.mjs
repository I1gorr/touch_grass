// Is it an installable, offline-capable web app? Checks the manifest, Chrome's own installability verdict, the service
// worker, and that the app reloads and works with no network at all. Needs `NO_SSL=1 npm run preview` (a service worker
// can't register on a self-signed https origin).
//   node e2e/pwa.mjs [http://127.0.0.1:4174/]
import { chromium } from 'playwright-core';

const URL_ = process.argv[2] ?? 'http://127.0.0.1:4174/';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'allow' });
await context.addInitScript(() => {
  if (!localStorage.getItem('touch_grass.settings')) localStorage.setItem('touch_grass.settings', JSON.stringify({ version: 1, fakeQuest: true, sttMode: 'fake', llmMode: 'fake', fakeDevices: true }));
});
const page = await context.newPage();
const problems = [];
const failed = [];
page.on('requestfailed', (r) => failed.push(`${r.url()} (${r.failure()?.errorText})`));
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && problems.push(`console.error: ${m.text()}`));
const ok = (m) => console.log(`ok   ${m}`);
const check = (cond, msg) => {
  if (!cond) {
    problems.push(msg);
    console.log(`FAIL ${msg}`);
  } else ok(msg);
};

await page.goto(URL_);
await page.getByRole('button', { name: 'Prepare quest' }).waitFor();

// 1. Manifest
const manifest = await (await fetch(new URL('manifest.webmanifest', URL_))).json();
check(manifest.display === 'standalone', 'manifest: standalone display');
check(manifest.name && manifest.short_name && manifest.start_url && manifest.theme_color && manifest.background_color, 'manifest: name, start_url and colours');
for (const size of ['192x192', '512x512']) check(manifest.icons.some((i) => i.sizes === size && i.type === 'image/png'), `manifest: ${size} PNG icon`);
check(manifest.icons.some((i) => i.purpose === 'maskable'), 'manifest: maskable icon');
for (const icon of manifest.icons) check((await fetch(new URL(icon.src, URL_))).ok, `icon file exists: ${icon.src}`);

// 2. Chrome's own installability check
const cdp = await context.newCDPSession(page);
await page.evaluate(() => navigator.serviceWorker.ready.then(() => 0));
await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 15000 });
// (Playwright's browser context counts as incognito, which Chrome lists as an error of its own: that one is not about the app.)
const installabilityErrors = (await cdp.send('Page.getInstallabilityErrors')).installabilityErrors.filter((e) => e.errorId !== 'in-incognito');
check(installabilityErrors.length === 0, `Chrome says it is installable${installabilityErrors.length ? ': ' + installabilityErrors.map((e) => e.errorId).join(', ') : ''}`);

// 3. Everything the app needs is cached
const cached = await page.evaluate(async () => {
  const urls = [];
  for (const n of await caches.keys()) for (const r of await (await caches.open(n)).keys()) urls.push(new URL(r.url).pathname);
  return urls;
});
for (const need of ['/index.html', '/fallback/demo_ways.json', '/fallback/demo_overpass.json', '/fallback/blurbs.json', '/manifest.webmanifest']) check(cached.includes(need), `cached for offline: ${need}`);
for (const f of ['Regular', 'Italic', 'Bold', 'BoldItalic']) check(cached.includes(`/fonts/AtkinsonHyperlegible-${f}.ttf`), `cached for offline: ${f} font`);
check(cached.some((p) => /^\/assets\/index-.*\.js$/.test(p)), 'cached for offline: app script');
check(cached.some((p) => /^\/assets\/planWorker-.*\.js$/.test(p)), 'cached for offline: route planner worker');
check(cached.some((p) => /^\/assets\/mlWorker-.*\.js$/.test(p)), 'cached for offline: model worker');

// 4. The app really works with no network, even after a full reload
await context.setOffline(true);
await page.reload();
await page.getByRole('button', { name: 'Prepare quest' }).waitFor({ timeout: 15000 });
ok('reloads and shows the home screen with no network');
await page.getByRole('button', { name: 'Prepare quest' }).click();
await page.getByText(/stops · loop back/).waitFor({ timeout: 30000 });
await page.getByRole('button', { name: 'Start this walk' }).click();
await page.getByText(/Stop 1 of/).waitFor({ timeout: 30000 });
ok('plans and starts a walk with no network');
const fontsOk = await page.evaluate(async () => { await document.fonts.ready; return [...document.fonts].filter((f) => f.status === 'loaded').length; });
check(fontsOk >= 1, `fonts render offline (${fontsOk} loaded)`);

if (failed.length) console.log('failed requests:\n  ' + failed.join('\n  '));
console.log(problems.length ? `\n${problems.length} problem(s):\n- ${problems.join('\n- ')}` : '\nNo console errors or page errors.');
await browser.close();
process.exit(problems.length ? 1 : 0);
