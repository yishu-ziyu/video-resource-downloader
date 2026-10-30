import { chromium } from 'playwright';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve('.');
const out = path.join(root, 'artifacts', 'douyin-popup');
await mkdir(out, { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), 'douyin-popup-'));
const target = process.env.DOUYIN_URL || 'https://www.douyin.com/jingxuan?modal_id=7700117223133711654';

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
await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => console.log('goto:', e.message));
await page.waitForTimeout(9000);
await page.evaluate(() => { const v = document.querySelector('video'); if (v) void v.play().catch(() => {}); });
await page.waitForTimeout(8000);

const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id);
const panel = await context.newPage();
await panel.setViewportSize({ width: 560, height: 600 });
await panel.goto(`chrome-extension://${extId}/popup.html?tab=${tabId}`);
await panel.waitForSelector('article', { timeout: 15000 });
await panel.waitForTimeout(2500);
await panel.screenshot({ path: path.join(out, 'popup.png'), fullPage: true });
console.log('cards:', await panel.locator('article').count());
for (const line of await panel.locator('article .video-title').allInnerTexts()) console.log('  title:', line.slice(0, 80));
console.log('count:', await panel.locator('#count').innerText());
console.log('default choice:', await panel.locator('article .version-picker').first().innerText());
console.log('done ->', path.join(out, 'popup.png'));

await panel.locator('article .thumbnail').first().click();
const verdict = await panel.evaluate(() => new Promise(resolve => {
  const video = document.querySelector('#preview-video');
  const fail = setTimeout(() => resolve('timeout'), 25000);
  video.addEventListener('loadeddata', () => { clearTimeout(fail); resolve(`readyState=${video.readyState} ${video.videoWidth}x${video.videoHeight}`); });
  video.addEventListener('error', () => { clearTimeout(fail); resolve(`error ${video.error?.code}`); });
}));
await panel.waitForTimeout(1500);
console.log('preview:', verdict, '| error shown:', !(await panel.locator('#preview-error').isHidden().catch(() => true)));
await panel.screenshot({ path: path.join(out, 'preview.png') });
await context.close();
