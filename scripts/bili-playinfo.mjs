import { chromium } from 'playwright';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const context = await chromium.launchPersistentContext(await mkdtemp(path.join(tmpdir(), 'bili-')), {
  channel: 'chromium', headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--disable-blink-features=AutomationControlled'],
});
const page = await context.newPage();
await page.goto('https://www.bilibili.com/video/BV1kMxM6FECM/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);
const data = await page.evaluate(() => {
  const dash = window.__playinfo__?.data?.dash;
  const pick = t => ({ id: t.id, codecs: t.codecs, bw: t.bandwidth, w: t.width, h: t.height, code: t.baseUrl?.match(/-(\d+)\.m4s/)?.[1] });
  return { duration: dash?.duration, video: dash?.video?.map(pick), audio: dash?.audio?.map(pick),
    dolby: dash?.dolby, flac: dash?.flac ? 'yes' : undefined };
});
console.log(JSON.stringify(data, null, 1));
await context.close();
