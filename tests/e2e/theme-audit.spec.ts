import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { THEME_KEY } from '../../src/utils/storageKeys';
import { characterThemeStyle } from '../../src/utils/characterTheme';

const characterRecords = JSON.parse(readFileSync('data/characters.json', 'utf8')) as Array<{ id: string; accent_color?: string }>;
const characterThemes = characterRecords
  .filter(record => typeof record?.id === 'string' && record.id.length > 0)
  .map(record => ({ id: record.id, style: characterThemeStyle(record.id, characterRecords) }));

// 美术巡检 —— 全局美术校准后的回归网。
// 检查三类会真实破相的问题:
//   1. 控制台运行时错误
//   2. 横向溢出(布局在窄屏被挤破)
//   3. 文字/背景对比度不足(白字压白底的那类缺陷)
// 前两类是硬失败;对比度做保守判定,只抓"几乎不可读"的极端值。
//
// 应用已恢复双主题，启动偏好与运行中的切换均须覆盖。

// Vue Router 路径（重构前是 /tools/*.html）
const PAGES = [
  '/',
  '/scene-explorer',
  '/showcase',
  '/gallery',
  '/character',
  '/lora',
  '/control',
  '/scenario',
  '/color-script',
  '/style',
  '/scene-manager',
  '/prompt-builder',
  '/chat',
  '/docs/index.html',
  '/docs/guides/art/philosophy.html',
  '/docs/roadmap.html',
  '/docs/guides/art/quality-standard.html',
  '/docs/guides/art/art-direction.html',
  '/docs/guides/characters/scene-spec.html',
  '/docs/guides/prompts/prompt-spec.html',
  '/docs/guides/prompts/tag-standard.html',
  '/docs/guides/art/worldview.html',
  '/docs/getting-started.html'
];

const THEMES = ['dark', 'light'] as const;

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push('pageerror: ' + error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    // 本地 SD / Ollama 未启动时的连接失败属环境噪音,不是页面缺陷
    if (/ECONNREFUSED|Failed to load resource|net::ERR|favicon/i.test(text)) return;
    errors.push('console: ' + text);
  });
  return errors;
}

async function applyTheme(page: Page, theme: string) {
  await page.evaluate((value) => {
    document.documentElement.setAttribute('data-theme', value);
  }, theme);
  // 等一帧,让 CSS 变量翻转后的样式生效
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
}

for (const theme of THEMES) {
  for (const target of PAGES) {
    test(`[${theme}] ${target} renders without errors, overflow or unreadable text`, async ({ page }) => {
      const errors = collectErrors(page);
      await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), { key: THEME_KEY, value: theme });
      await page.goto(target);
      await applyTheme(page, theme);
      // SPA 路由要等异步场景数据与图片落位，否则会在半渲染状态上做判定。
      // 控制面板每 3 秒轮询 /api/status（内部还要探测 SD/TTS/Ollama），
      // networkidle 永远不会到达，这里只能定时等待。
      if (target !== '/control') {
        await page.waitForLoadState('networkidle').catch(() => {});
      }
      await page.waitForTimeout(900);

      // ---- 1. 运行时错误 ----
      expect(errors, `${target} @ ${theme} 有运行时错误`).toEqual([]);

      // ---- 2. 横向溢出 ----
      const overflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth - doc.clientWidth;
      });
      expect(overflow, `${target} @ ${theme} 横向溢出 ${overflow}px`).toBeLessThanOrEqual(1);

      // ---- 3. 对比度:抓"几乎不可读"的文字 ----
      const unreadable = await page.evaluate(() => {
        const colorCanvas = document.createElement('canvas');
        colorCanvas.width = colorCanvas.height = 1;
        const colorContext = colorCanvas.getContext('2d', { willReadFrequently: true })!;
        function parse(color: string): [number, number, number, number] | null {
          const match = color.match(/rgba?\(([^)]+)\)/);
          if (!match) {
            // Chromium 对 color-mix 返回 color(srgb ...)，漏掉它会把深色遮罩当透明。
            if (!CSS.supports('color', color)) return null;
            colorContext.clearRect(0, 0, 1, 1);
            colorContext.fillStyle = color;
            colorContext.fillRect(0, 0, 1, 1);
            const [r, g, b, alpha] = colorContext.getImageData(0, 0, 1, 1).data;
            return [r, g, b, alpha / 255];
          }
          const parts = match[1].split(',').map((value) => parseFloat(value.trim()));
          return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
        }
        function luminance(rgb: [number, number, number]) {
          const [r, g, b] = rgb.map((channel) => {
            const c = channel / 255;
            return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
          });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        }
        function blend(fg: [number, number, number, number], bg: [number, number, number]): [number, number, number] {
          const a = fg[3];
          return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a)];
        }
        // 逐级向上找第一个不透明的背景。
        // 返回 null 表示"底是图片或渐变" —— computed style 读不到它的实际像素,
        // 强算出来的比率是假的。这类文字压在画作/渐变之上,应走 --on-art-* /
        // --on-mood-text,由 check-contrast.js 与人工审核把关,不在此判定。
        function effectiveBg(element: Element): [number, number, number] | null {
          let node: Element | null = element;
          const stack: [number, number, number, number][] = [];
          while (node) {
            const style = getComputedStyle(node);
            if (style.backgroundImage && style.backgroundImage !== 'none') return null;
            const bg = parse(style.backgroundColor);
            if (bg && bg[3] > 0) {
              stack.push(bg);
              if (bg[3] >= 0.999) break;
            }
            node = node.parentElement;
          }
          let base: [number, number, number] = [255, 255, 255];
          for (let i = stack.length - 1; i >= 0; i -= 1) base = blend(stack[i], base);
          return base;
        }
        // 文字是否浮在同层的 <img> 之上(画廊说明条、样张标题这类)
        function sitsOnImage(element: Element): boolean {
          let node: Element | null = element;
          for (let depth = 0; node && depth < 5; depth += 1) {
            if (node.querySelector(':scope > img, :scope > picture, :scope > video, :scope > canvas')) return true;
            node = node.parentElement;
          }
          return false;
        }

        const findings: string[] = [];
        const nodes = [...document.querySelectorAll('body *')].filter((element) => {
          if (!(element instanceof HTMLElement)) return false;
          const style = getComputedStyle(element);
          if (style.visibility === 'hidden' || style.display === 'none' || parseFloat(style.opacity) < 0.15) return false;
          // 只看直接承载文字的元素
          const text = [...element.childNodes]
            .filter((child) => child.nodeType === Node.TEXT_NODE)
            .map((child) => child.textContent || '')
            .join('')
            .trim();
          if (text.length < 2) return false;
          // 渐变裁切文字的 fill 是 transparent,对比度无意义
          if (style.webkitTextFillColor === 'rgba(0, 0, 0, 0)') return false;
          const rect = element.getBoundingClientRect();
          return rect.width > 8 && rect.height > 6;
        });

        for (const element of nodes.slice(0, 320)) {
          const style = getComputedStyle(element);
          const fg = parse(style.color);
          if (!fg) continue;
          if (sitsOnImage(element)) continue;
          const bg = effectiveBg(element);
          if (!bg) continue;
          const front = blend(fg, bg);
          const l1 = luminance(front);
          const l2 = luminance(bg);
          const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
          // 1.8:1 以下属于"几乎看不见",这是本次要抓的白字压白底一类缺陷。
          // 不用 4.5:1 全量门禁,避免把装饰性弱化文字全部判失败。
          if (ratio < 1.8) {
            const label = element.tagName.toLowerCase() +
              (element.className && typeof element.className === 'string' ? '.' + element.className.trim().split(/\s+/).join('.') : '');
            findings.push(`${label} ratio=${ratio.toFixed(2)} color=${style.color}`);
          }
        }
        return [...new Set(findings)];
      });

      expect(unreadable, `${target} @ ${theme} 存在几乎不可读的文字`).toEqual([]);
    });
  }
}


for (const theme of THEMES) {
  test('[' + theme + '] character accent meets AA on computed workspace surfaces', async ({ page }) => {
    const ids = characterThemes.map(character => character.id);
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), { key: THEME_KEY, value: theme });
    await page.goto('/prompt-builder');
    await expect(page.locator('.pb').first()).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const failures = await page.evaluate((characters) => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d', { willReadFrequently: true })!;
      function rgb(color: string) {
        context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
      }
      function luminance(values: number[]) {
        const v = values.map(n => { const c = n / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; });
        return v[0] * .2126 + v[1] * .7152 + v[2] * .0722;
      }
      const host = document.createElement('div'); host.className = 'pb'; host.style.transition = 'none';
      const probe = document.createElement('span'); probe.style.color = 'var(--accent)'; host.append(probe);
      document.body.append(host);
      const failures: string[] = [];
      try {
        for (const character of characters) {
          host.dataset.character = character.id;
          for (const [property, value] of Object.entries(character.style)) {
            host.style.setProperty(property, String(value));
          }
          for (const surface of ['--bg-deep', '--bg-base', '--bg-surface', '--bg-elevated']) {
            probe.style.backgroundColor = 'var(' + surface + ')';
            const computed = getComputedStyle(probe);
            const a = luminance(rgb(computed.color)), b = luminance(rgb(computed.backgroundColor));
            const contrast = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
            if (contrast < 4.5) failures.push(character.id + '/' + surface + ': ' + contrast.toFixed(2));
          }
        }
      } finally { host.remove(); }
      return failures;
    }, characterThemes);
    expect(ids.length).toBeGreaterThan(100);
    expect(failures).toEqual([]);
    await page.screenshot({ path: 'runtime/theme-workspace-' + theme + '.png', fullPage: true });
  });
}
