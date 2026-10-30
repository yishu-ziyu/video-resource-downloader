import { chromium } from 'playwright';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const site = process.argv[2] || 'bili';
const target = process.env.TARGET_URL;
const root = path.resolve('.');
const out = path.join(root, 'artifacts', `probe-${site}`);
await mkdir(out, { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), `probe-${site}-`));

const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: true, timeout: 45000,
  viewport: { width: 1440, height: 900 },
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio',
    '--disable-blink-features=AutomationControlled'],
});
context.setDefaultTimeout(20000);
const page = await context.newPage();

const requests = [];
page.on('request', req => {
  const url = req.url();
  if (/bilivideo|xhscdn|sns-video|hdslb|upos/.test(url)) requests.push({ url, type: req.resourceType(), headers: req.headers() });
});

await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(e => console.log('goto:', e.message));
await page.waitForTimeout(8000);
await page.evaluate(() => { const v = document.querySelector('video'); if (v) void v.play().catch(() => {}); });
await page.waitForTimeout(8000);

const info = await page.evaluate(() => {
  const videos = [...document.querySelectorAll('video')].map(v => ({
    src: (v.currentSrc || v.src || '').slice(0, 80), duration: v.duration,
    readyState: v.readyState, w: v.videoWidth, h: v.videoHeight, poster: (v.poster || '').slice(0, 80),
  }));
  const globals = {};
  for (const key of ['__INITIAL_STATE__', '__playinfo__', 'window.__INITIAL_STATE__', '__NEXT_DATA__']) {
    try { globals[key] = typeof window[key.replace('window.', '')] !== 'undefined'; } catch { globals[key] = false; }
  }
  const scripts = [...document.querySelectorAll('script')].map(s => ({ id: s.id, type: s.type, len: s.textContent.length }))
    .filter(s => s.id || s.type?.includes('json'));
  return { url: location.href, title: document.title, videos, globals, scripts };
});
await writeFile(path.join(out, 'page.json'), JSON.stringify(info, null, 1));
await writeFile(path.join(out, 'requests.json'), JSON.stringify(requests.slice(0, 60), null, 1));
await page.screenshot({ path: path.join(out, 'page.png'), timeout: 60000 }).catch(e => console.log('shot:', e.message));

console.log(JSON.stringify({ url: info.url, title: info.title.slice(0, 70), videos: info.videos, globals: info.globals }, null, 1));
console.log('media requests:', requests.length);
for (const r of requests.slice(0, 8)) console.log(' ', r.type, r.url.slice(0, 140));
console.log('out ->', out);
await context.close();
