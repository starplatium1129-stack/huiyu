// Probe wl-live2d drawable visibility in MODEL coordinates.
import { chromium } from '@playwright/test';
import type { ProbeWindow } from './probe-types.js';
const base = 'http://localhost:5173/poc/live2d-compare/';

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 600, height: 600 } });
await page.goto(base, { waitUntil: 'networkidle' });
await page.waitForTimeout(8000);

const report = await page.evaluate(() => {
  const model = (window as ProbeWindow).__model;
  const cm = model?.internalModel?.coreModel;
  if (!cm) return { error: 'no coreModel' };
  const n = cm.getDrawableCount();
  const visible = [];
  for (let i = 0; i < n; i++) {
    if (cm.getDrawableDynamicFlagIsVisible(i)) {
      const v = cm.getDrawableVertexPositions(i); // canvas-space, origin center, y up
      let minY = 1e9, maxY = -1e9;
      for (let j = 0; j < v.length; j += 2) {
        if (v[j + 1] < minY) minY = v[j + 1];
        if (v[j + 1] > maxY) maxY = v[j + 1];
      }
      visible.push({ id: cm.getDrawableId(i), minY, maxY, opacity: cm.getDrawableOpacity(i) });
    }
  }
  visible.sort((a, b) => a.minY - b.minY);
  return {
    visibleCount: visible.length,
    lowest10: visible.slice(0, 12),
    highest10: visible.slice(-12),
  };
});

console.log(JSON.stringify(report, null, 2));
await browser.close();
