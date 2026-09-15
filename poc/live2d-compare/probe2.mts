// Compare wl-live2d (official Core Web) raw drawable data with our C++ Core reading.
import { chromium } from '@playwright/test';
import type { ProbeWindow } from './probe-types.js';
const base = 'http://localhost:5173/poc/live2d-compare/';

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 600, height: 600 } });
await page.goto(base, { waitUntil: 'networkidle' });
await page.waitForTimeout(15000);

const report = await page.evaluate(() => {
  const model = (window as ProbeWindow).__model;
  const cm = model?.internalModel?.coreModel;
  if (!cm) return { error: 'no coreModel' };
  const n = cm.getDrawableCount();
  const pick = (id: string) => {
    const idx = cm.getDrawableIndex(id);
    if (idx < 0) return null;
    const v = cm.getDrawableVertexPositions(idx); // raw canvas space
    const vc = cm.getDrawableVertexCount(idx);
    const ic = cm.getDrawableVertexIndexCount(idx);
    const masks = cm.getDrawableMaskCounts()[idx];
    return {
      idx,
      vc,
      ic,
      masks,
      first6: Array.from(v.slice(0, 12)),
      first6idx: Array.from(cm.getDrawableVertexIndices(idx).slice(0, 12)),
      visible: cm.getDrawableDynamicFlagIsVisible(idx),
      opacity: cm.getDrawableOpacity(idx),
    };
  };
  return {
    drawableCount: n,
    d0: pick('ArtMesh0'),
    d335: pick('ArtMesh335'),
    d356: pick('ArtMesh356'),
    d133: pick('ArtMesh133'),
    d5: pick('ArtMesh5'),
  };
});

console.log(JSON.stringify(report, null, 2));
await browser.close();
