import { chromium } from 'playwright';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve('.');
const out = path.join(root, 'artifacts', 'douyin-probe');
await mkdir(out, { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), 'douyin-probe-'));
const target = process.env.DOUYIN_URL || 'https://www.douyin.com/jingxuan?modal_id=7700117223133711654';

const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: process.env.HEADED ? false : true, timeout: 45000,
  viewport: { width: 1440, height: 900 },
  args: [`--disable-extensions-except=${root}/extension`, `--load-extension=${root}/extension`,
    '--autoplay-policy=no-user-gesture-required', '--mute-audio',
    '--disable-blink-features=AutomationControlled'],
});
context.setDefaultTimeout(15000);
let [worker] = context.serviceWorkers();
worker ||= await context.waitForEvent('serviceworker');
const extId = worker.url().split('/')[2];

const page = await context.newPage();
await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => console.log('goto:', e.message));
await page.waitForTimeout(8000);
await page.screenshot({ path: path.join(out, 'page.png'), timeout: 60000 }).catch(e => console.log('shot:', e.message.split('\n')[0]));

const dump = await page.evaluate(() => {
  const info = el => {
    const attrs = {};
    for (const a of el.attributes) attrs[a.name] = a.value.slice(0, 400);
    const chain = [];
    let node = el;
    for (let i = 0; i < 5 && node; i++, node = node.parentElement) {
      chain.push({
        tag: node.tagName.toLowerCase(), cls: (node.className || '').toString().slice(0, 120),
        id: node.id || '', attrs: Object.fromEntries([...(node.attributes || [])]
          .filter(a => /^(data-|aria-|id|role)/.test(a.name)).map(a => [a.name, a.value.slice(0, 200)])),
      });
    }
    return { attrs, chain };
  };
  const videos = [...document.querySelectorAll('video')].map(v => ({
    src: v.src || '', currentSrc: v.currentSrc || '', poster: v.poster || '',
    duration: v.duration, w: v.videoWidth, h: v.videoHeight, readyState: v.readyState,
    paused: v.paused, ...info(v),
  }));
  const render = document.getElementById('RENDER_DATA')?.textContent.slice(0, 200) || null;
  const scripts = [...document.querySelectorAll('script[id]')].map(s => s.id);
  return {
    title: document.title, url: location.href,
    videoCount: videos.length, videos, render: !!render, scripts,
    bodyClasses: document.body.className,
  };
});
await writeFile(path.join(out, 'dom.json'), JSON.stringify(dump, null, 2));
console.log('title:', dump.title);
console.log('videos:', dump.videoCount);
for (const v of dump.videos) console.log('  src:', v.src || '(none)', '| currentSrc:', v.currentSrc.slice(0, 100), '| dur:', v.duration, v.w + 'x' + v.h);
console.log('RENDER_DATA:', dump.render ? 'yes' : 'no', '| script ids:', dump.scripts.join(','));

// Try clicking a video element to start playback, then wait for media requests.
const played = await page.evaluate(() => {
  const v = [...document.querySelectorAll('video')].find(v => v.videoWidth > 0) || document.querySelector('video');
  if (!v) return false;
  void v.play().catch(() => {});
  return true;
});
await page.waitForTimeout(12000);
await page.screenshot({ path: path.join(out, 'playing.png'), timeout: 60000 }).catch(e => console.log('shot:', e.message.split('\n')[0]));

const state = await worker.evaluate(async () => {
  const all = await chrome.storage.session.get(null);
  const result = {};
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith('tab:')) result[key] = value;
    if (key.startsWith('media:')) result[key] = value;
  }
  return result;
});
await writeFile(path.join(out, 'resources.json'), JSON.stringify(state, null, 2));
for (const [key, items] of Object.entries(state)) {
  if (key.startsWith('tab:')) for (const item of items) console.log('item:', item.kind, item.url.slice(0, 160), '| media:', item.media ? item.media.title : 'NONE');
  if (key.startsWith('media:')) for (const p of items) console.log('player:', p.title, '| urls:', p.urls.length, '| poster:', p.poster.slice(0, 80));
}
await context.close();
console.log('done ->', out);
