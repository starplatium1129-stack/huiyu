// Screenshot nene via wl-live2d (web pipeline) for side-by-side comparison
// with the native renderer. Run: node poc/live2d-compare/shot.mjs
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProbeWindow } from './probe-types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });

// needs: npm run build && node server.js running on 127.0.0.1:3000
const base = process.env.GATEWAY_URL || 'http://localhost:5173';

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 600, height: 600 } });
const errors: string[] = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => {
  if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`);
});

await page.goto(`${base}/poc/live2d-compare/`, { waitUntil: 'networkidle' });
// wait for model load + a few frames of idle motion
await page.waitForTimeout(8000);
const state = await page.evaluate(() => (window as ProbeWindow).__state);
console.log('wl-live2d state:', state);
await page.screenshot({ path: path.join(outDir, 'web_nene_idle.png'), omitBackground: true });

// also grab the canvas pixel summary to compare with native stats
const stats = await page.evaluate(() => {
  const canvas = document.querySelector('canvas') || document.querySelector<HTMLCanvasElement>('#stage canvas');
  if (!canvas) return null;
  try {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let opaque = 0;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 8) {
        opaque++;
        r += data[i]; g += data[i + 1]; b += data[i + 2];
      }
    }
    return { w: canvas.width, h: canvas.height, opaque, avg_rgb: opaque ? [Math.round(r / opaque), Math.round(g / opaque), Math.round(b / opaque)] : null };
  } catch (e) {
    return { error: String(e) };
  }
});
console.log('web canvas stats:', JSON.stringify(stats));
console.log('page errors:', errors.length ? errors : 'none');
await browser.close();
