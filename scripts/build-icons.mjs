// Rasterize the repository-owned vector; Chromium extension icons require PNG.
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
const svg = await readFile(new URL('../extension/icons/source.svg', import.meta.url), 'utf8');
const browser = await chromium.launch({ channel: 'chromium', headless: true, timeout: 30000 });
try {
  const page = await browser.newPage();
  for (const size of [16, 32, 48, 128]) {
    const base64 = await page.evaluate(async ({ svg, size }) => {
      const image = new Image(); image.src = 'data:image/svg+xml;base64,' + btoa(svg);
      await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
      canvas.getContext('2d').drawImage(image, 0, 0, size, size);
      return canvas.toDataURL('image/png').split(',')[1];
    }, { svg, size });
    await writeFile(new URL(`../extension/icons/icon-${size}.png`, import.meta.url), Buffer.from(base64, 'base64'));
  }
} finally { await browser.close(); }
