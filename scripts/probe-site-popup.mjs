import { chromium } from 'playwright';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve('.');
const site = process.argv[2] || 'bili';
const target = process.env.TARGET_URL || 'https://www.bilibili.com/video/BV1kMxM6FECM/';
const out = path.join(root, 'artifacts', `popup-${site}`);
await mkdir(out, { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), `popup-${site}-`));

const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: true, timeout: 45000,
  viewport: { width: 1440, height: 900 },
  args: [`--disable-extensions-except=${root}/extension`, `--load-extension=${root}/extension`,
    '--autoplay-policy=no-user-gesture-required', '--mute-audio',
    '--disable-blink-features=AutomationControlled'],
});
context.setDefaultTimeout(20000);
let [worker] = context.serviceWorkers();
worker ||= await context.waitForEvent('serviceworker');
const extId = worker.url().split('/')[2];

const page = await context.newPage();
await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(e => console.log('goto:', e.message));
await page.waitForTimeout(8000);
await page.evaluate(() => { const v = document.querySelector('video'); if (v) void v.play().catch(() => {}); });
await page.waitForTimeout(8000);

const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id);
const panel = await context.newPage();
await panel.setViewportSize({ width: 560, height: 640 });
await panel.goto(`chrome-extension://${extId}/popup.html?tab=${tabId}`);
await panel.waitForSelector('article', { timeout: 15000 }).catch(() => console.log('no cards'));
await panel.waitForTimeout(2500);
await panel.screenshot({ path: path.join(out, 'popup.png'), fullPage: true });
console.log('cards:', await panel.locator('article').count());
for (const line of await panel.locator('article .video-title').allInnerTexts()) console.log('  title:', line.slice(0, 80));
console.log('count:', await panel.locator('#count').innerText());
for (const picker of await panel.locator('article .version-picker').allInnerTexts())
  console.log('  picker:', picker.replace(/\n/g, ' | ').slice(0, 140));

const card = panel.locator('#resources article').first();
if (await card.count()) {
  await card.locator('.version-picker').click();
  const opts = await panel.getByRole('option').allInnerTexts();
  console.log('options:', opts.length);
  for (const o of opts.slice(0, 12)) console.log('  opt:', o.slice(0, 90));
  await panel.keyboard.press('Escape');
  await card.locator('.thumbnail').click();
  const verdict = await panel.evaluate(() => new Promise(resolve => {
    const video = document.querySelector('#preview-video');
    const fail = setTimeout(() => resolve('timeout'), 25000);
    video.addEventListener('loadeddata', () => { clearTimeout(fail); resolve(`readyState=${video.readyState} ${video.videoWidth}x${video.videoHeight}`); });
    video.addEventListener('error', () => { clearTimeout(fail); resolve(`error ${video.error?.code}`); });
  }));
  await panel.waitForTimeout(1500);
  console.log('preview:', verdict, '| error shown:', !(await panel.locator('#preview-error').isHidden().catch(() => true)));
  await panel.screenshot({ path: path.join(out, 'preview.png') });
}
console.log('done ->', out);
await context.close();
