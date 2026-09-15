'use strict';
/**
 * UI 审核疑点客观测量（视觉审核的 DOM 侧复核）：
 *  1) 导演台故事输入框：文本重影/绝对定位覆盖物（区分动画截帧伪影与真实缺陷）
 *  2) 场景列表滚动容器：scrollHeight vs clientHeight（截断是否为设计内滚动）
 *  3) 各工作台页右下角 route-index 水印与内容面板的碰撞面积
 * 用法：node scripts/tests/probe-ui-audit.js [baseUrl]
 * 需要网关已启动（node server.js）与系统 Edge/Chrome。
 */
const { chromium }: typeof import('playwright') = require('playwright');
const { existsSync }: typeof import('node:fs') = require('node:fs');
const candidates = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const executablePath = candidates.find(existsSync);
const base = process.argv[2] || 'http://127.0.0.1:3000';

async function probeStoryBox(page) {
  await page.goto(base + '/prompt-builder?scene=sc001');
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1600);
  return page.evaluate(() => {
    const ta = document.querySelector('textarea.story-input');
    if (!ta) return { found: false };
    const r = ta.getBoundingClientRect();
    const style = getComputedStyle(ta);
    const overlaps = [];
    for (const el of document.querySelectorAll('.pb *')) {
      if (el === ta || !(el instanceof HTMLElement)) continue;
      const er = el.getBoundingClientRect();
      const inter = Math.max(0, Math.min(r.right, er.right) - Math.max(r.left, er.left))
        * Math.max(0, Math.min(r.bottom, er.bottom) - Math.max(r.top, er.top));
      if (inter > 20) {
        const cs = getComputedStyle(el);
        if (cs.position !== 'static' && cs.zIndex !== 'auto' && parseFloat(cs.zIndex) > 0 && cs.pointerEvents !== 'none') {
          overlaps.push({ cls: String(el.className).slice(0, 60), z: cs.zIndex, area: Math.round(inter) });
        }
      }
    }
    overlaps.sort((a, b) => b.area - a.area);
    return { found: true, valueLen: ta.value.length, textShadow: style.textShadow, overlaps: overlaps.slice(0, 4) };
  });
}

async function probeSceneList(page) {
  await page.goto(base + '/prompt-builder');
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1200);
  return page.evaluate(() => {
    const el = document.querySelector('.scene-list');
    if (!el) return { found: false };
    return {
      found: true,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      overflowY: getComputedStyle(el).overflowY,
      childCount: el.children.length,
    };
  });
}

async function probeWatermarks(page) {
  const out = {};
  for (const path of ['/control', '/training', '/scene-manager', '/lora', '/video-studio', '/prompt-builder']) {
    await page.goto(base + path);
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(900);
    out[path] = await page.evaluate(() => {
      const wm = document.querySelector('.route-index');
      if (!wm) return { watermark: false };
      const wr = wm.getBoundingClientRect();
      let maxInter = 0;
      let hit = '';
      for (const el of document.querySelectorAll('button, input, select, textarea, section, article, .panel-card, .card')) {
        if (!(el instanceof HTMLElement)) continue;
        const er = el.getBoundingClientRect();
        if (er.width < 40 || er.height < 24) continue;
        const inter = Math.max(0, Math.min(wr.right, er.right) - Math.max(wr.left, er.left))
          * Math.max(0, Math.min(wr.bottom, er.bottom) - Math.max(wr.top, er.top));
        if (inter > maxInter) { maxInter = inter; hit = String(el.className).slice(0, 50); }
      }
      return { watermark: true, opacity: getComputedStyle(wm).opacity, maxIntersect: Math.round(maxInter), hit };
    });
  }
  return out;
}

/**
 * 浅色主题对比度测量：目标元素的前景色 vs 最近不透明祖先背景色。
 * 返回 WCAG 对比度（4.5 以下记 low）。用于复核视觉审核的"浅底浅字"类结论。
 * 颜色解析/合成在浏览器侧执行（parseColor + alpha composite）。
 */
async function probeLightContrast(page) {
  const targets = {
    '/control': [
      { name: 'status-tile small', selector: '.status-tile small' },
      { name: 'status-tile strong', selector: '.status-tile strong' },
      { name: 'panel-kicker', selector: '.panel-kicker' },
      { name: 'toolbar button', selector: '.control-toolbar button' },
    ],
    '/training': [
      { name: 'feature chip', selector: '.feature-chip, .training-chip, [class*="chip"] span' },
      { name: 'log placeholder', selector: '#training-log-title, .log-empty, [class*="log"] [class*="empty"], .log-panel [class*="placeholder"]' },
      { name: 'panel heading', selector: '.panel-heading' },
    ],
    '/scene-manager': [
      { name: 'table header', selector: 'th' },
      { name: 'table id cell', selector: 'td:first-child, .scene-id, [class*="id"]' },
      { name: 'action buttons', selector: '.scene-manager table button, .sm-actions button, [class*="action"] button' },
    ],
  };
  const out = {};
  for (const [path, list] of Object.entries(targets)) {
    await page.goto(base + path);
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(900);
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'light');
    });
    await page.waitForTimeout(300);
    out[path] = await page.evaluate((list) => {
      /** rgb()/rgba()/hex → [r,g,b,a]（0-255, a 0-1），color(srgb) 与未知格式返回 null */
      function parseColor(value) {
        const rgb = value.match(/rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\)/);
        if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])];
        const hex = value.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})/i);
        if (hex) return [parseInt(hex[1], 16), parseInt(hex[2], 16), parseInt(hex[3], 16), 1];
        return null;
      }
      /** 半透明前景合成到不透明底色上 */
      function composite(fg, bg) {
        const a = fg[3];
        return [0, 1, 2].map(i => Math.round(fg[i] * a + bg[i] * (1 - a)));
      }
      function luminance(rgb) {
        const [r, g, b] = rgb.map(v => {
          const c = v / 255;
          return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      }
      function contrastRatio(fgRgb, bgRgb) {
        const l1 = luminance(fgRgb);
        const l2 = luminance(bgRgb);
        const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
        return (hi + 0.05) / (lo + 0.05);
      }
      // 页面底色（body 实际合成后的背景）
      const bodyBg = parseColor(getComputedStyle(document.body).backgroundColor) || [255, 255, 255];
      const results = [];
      for (const t of list) {
        let el = document.querySelector(t.selector);
        if (!el) { results.push({ name: t.name, missing: true }); continue; }
        const style = getComputedStyle(el);
        let fg = parseColor(style.color);
        if (!fg) { results.push({ name: t.name, unparsedFg: style.color }); continue; }
        // 前景若有透明度先合成
        if (fg[3] < 1) fg = composite(fg, bodyBg);
        // 背景：从元素向上找最近的带背景节点，逐层合成
        let bg = bodyBg;
        let node = el;
        while (node && node !== document.documentElement) {
          const b = parseColor(getComputedStyle(node).backgroundColor);
          if (b && b[3] > 0) {
            const opaque = b[3] >= 1 ? [b[0], b[1], b[2]] : composite(b, bg);
            bg = opaque;
            if (b[3] >= 1) break;
          }
          node = node.parentElement;
        }
        results.push({ name: t.name, fg: style.color, bg: getComputedStyle(node || document.body).backgroundColor, ratio: Math.round(contrastRatio(fg, bg) * 100) / 100 });
      }
      return results;
    }, list);
  }
  return out;
}

(async () => {
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  await page.addInitScript(() => {
    try { localStorage.setItem('aics_theme', 'dark'); } catch {}
  });
  console.log(JSON.stringify({
    storyBox: await probeStoryBox(page),
    sceneList: await probeSceneList(page),
    watermarks: await probeWatermarks(page),
    lightContrast: await probeLightContrast(page),
  }, null, 2));
  await browser.close();
})().catch(err => { console.error(err.message); process.exit(1); });
