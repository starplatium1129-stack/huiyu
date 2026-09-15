'use strict';

// 对比度核算 —— 验证设计 token 是否满足 DESIGN.md §Colors 的 WCAG AA。
// 核算深色基线与应用真实加载的浅色覆盖；解析失败必须报错。
// 用法: node scripts/maintenance/check-contrast.js
//
// 只核算"会被当文字色使用"的 token(功能色 + mood + 角色品牌色)。
// AA 正文阈值 4.5:1;大号文字/图形 3:1。这里一律按 4.5 严格核算。

const sources: typeof import('./style-sources') = require('./style-sources');

// 必须读应用真正加载的那一份。曾经这里读 css/design-system.css，
// 而 SPA 加载的是 src/assets/css/design-system.css —— 门槛在审计一棵死树。
const css = sources.read(sources.DESIGN_SYSTEM);
const lightCss = sources.read('src/assets/css/light-theme.css');

function hexToRgb(hex: any) {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? value.split('').map((c: any) => c + c).join('') : value;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

function luminance(rgb: any) {
  const [r, g, b] = rgb.map((channel: any) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(fg: any, bg: any) {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

// 精确匹配选择器，避免 :root 误取 :root[data-theme] 或嵌套规则。
function block(selector: any, source: any = css) {
  const map: Record<string, any> = {};
  const clean = source.replace(/\/\*[^]*?\*\//g, '');
  for (const rule of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!rule[1].split(',').map((s: any) => s.trim()).includes(selector)) continue;
    for (const match of rule[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) map[match[1]] = match[2].trim();
  }
  if (!Object.keys(map).length) throw new Error('Missing CSS token block: ' + selector);
  return map;
}
const dark = block(':root');
const light = { ...dark, ...block(':root[data-theme="light"]', lightCss) };
const themes = [['dark', dark], ['light', light]];

// 真正会被当文字色使用的 token。
// 功能色与 mood 色的原 token 只做背景/描边,故不在此列 —— 文字走 --*-text。
const TEXT_TOKENS = [
  '--success-text', '--warning-text', '--danger-text', '--info-text',
  '--mood-joy-text', '--mood-love-text', '--mood-calm-text',
  '--mood-sad-text', '--mood-tension-text', '--mood-warmth-text',
  '--nene-violet', '--natsume-amber', '--accent', '--accent-violet',
  '--text-primary', '--text-secondary', '--text-muted', '--text-disabled'
];

// 解开 var(--x) 别名链,拿到最终字面值
function resolve(tokens: any, name: any, depth: any): any {
  const raw = tokens[name];
  if (!raw) return null;
  if ((depth || 0) > 8) return null;
  const alias = raw.match(/^var\(\s*(--[\w-]+)\s*\)$/);
  return alias ? resolve(tokens, alias[1], (depth || 0) + 1) : raw;
}

// 文字实际会落在的表面。只测 --bg-deep 是不够的:
// --text-muted 合成到 --bg-elevated 上只有 4.03,而它确实用在那个表面。
const SURFACES = ['--bg-deep', '--bg-base', '--bg-surface', '--bg-elevated'];

// 括号内的逗号属于 var/color-mix 参数，不能用单个正则截断。
function splitArgs(value: any) {
  const parts: any[] = []; let depth = 0, start = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '(') depth++;
    if (value[i] === ')') depth--;
    if (value[i] === ',' && depth === 0) { parts.push(value.slice(start, i).trim()); start = i + 1; }
  }
  parts.push(value.slice(start).trim());
  return parts;
}
function compositeSurface(tokens: any, name: any, parentRgb?: any, depth: any = 0) {
  return resolveColor(tokens, tokens[name], parentRgb, depth);
}
function resolveColor(tokens: any, expr: any, parentRgb?: any, depth: any = 0) {
  if (!expr || depth > 16) return null;
  const value = expr.replace(/!important/g, '').trim();
  const alias = value.match(/^var\((.*)\)$/);
  if (alias) {
    const [name, fallback] = splitArgs(alias[1]);
    return resolveColor(tokens, tokens[name] === undefined ? fallback : tokens[name], parentRgb, depth + 1);
  }
  if (value === 'transparent') return parentRgb || null;
  const hex = value.match(/^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i);
  if (hex) {
    const full = hex[1].length <= 4 ? [...hex[1]].map((c: any) => c + c).join('') : hex[1];
    const rgb = hexToRgb('#' + full.slice(0, 6));
    const alpha = full.length === 8 ? parseInt(full.slice(6), 16) / 255 : 1;
    if (alpha < 1 && !parentRgb) return null;
    return rgb.map((c: any, i: any) => c * alpha + (parentRgb?.[i] || 0) * (1 - alpha));
  }
  const rgba = value.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)\s*(?:[,/]\s*([\d.]+)(%)?)?\s*\)$/);
  if (rgba) {
    const rgb = rgba.slice(1, 4).map(Number);
    const alpha = rgba[4] === undefined ? 1 : Number(rgba[4]) / (rgba[5] ? 100 : 1);
    if (rgb.some((c: any) => !Number.isFinite(c) || c > 255) || !Number.isFinite(alpha) || alpha > 1 || (alpha < 1 && !parentRgb)) return null;
    return rgb.map((c: any, i: any) => c * alpha + (parentRgb?.[i] || 0) * (1 - alpha));
  }
  const mix = value.match(/^color-mix\((.*)\)$/);
  if (mix) {
    const [space, first, second, extra] = splitArgs(mix[1]);
    if (space !== 'in srgb' || !first || !second || extra) return null;
    const weighted = first.match(/^(.*)\s+([\d.]+)%$/);
    if (!weighted || !Number.isFinite(Number(weighted[2])) || Number(weighted[2]) > 100) return null;
    const weight = Number(weighted[2]) / 100;
    const a: any = resolveColor(tokens, weighted[1], parentRgb, depth + 1);
    const b: any = resolveColor(tokens, second, parentRgb, depth + 1);
    return a && b ? a.map((c: any, i: any) => c * weight + b[i] * (1 - weight)) : null;
  }
  return null;
}

function characterThemes() {
  const director = sources.read('src/assets/css/director/tokens.css');
  const registered = new Set((require('../../data/popular-onboarding.json') as typeof import('../../data/popular-onboarding.json')).characters.map((c: any) => c.id));
  const onboarding = block('.pb[data-onboarding-theme="true"]', director);
  const selectors = [...new Set([...director.matchAll(/\.pb\[data-character="[^"]+"\]/g)].map((m: any) => m[0]))];
  return themes.flatMap(([theme, tokens]: any) => selectors.map((selector: any) => [theme + ' / ' + selector, {
    ...tokens, ...block('.pb', director),
    ...(registered.has(selector.match(/data-character="([^"]+)"/)[1]) ? onboarding : {}),
    ...block(selector, director),
    ...(theme === 'light' ? block(':root[data-theme="light"] .pb', lightCss) : {}),
  }]));
}

function run() {
  let failures = 0;

  for (const [themeName, tokens] of themes) {
    const deepRaw = tokens['--bg-deep'];
    if (!/^#/.test(deepRaw || '')) { failures++; console.error(themeName + ': 背景无法解析'); continue; }
    const deep = hexToRgb(deepRaw);

    for (const surfaceToken of SURFACES) {
      const bg = compositeSurface(tokens, surfaceToken, deep);
      if (!bg) { failures++; console.error(themeName + ': 无法解析 ' + surfaceToken); continue; }
      const hex = '#' + bg.map((c: any) => Math.round(c).toString(16).padStart(2, '0')).join('');
      console.log('\n=== ' + themeName + ' theme / ' + surfaceToken + ' (合成后 ' + hex + ') ===');
      for (const name of TEXT_TOKENS) {
        const raw = resolve(tokens, name, undefined);
        const fg = compositeSurface(tokens, name, bg);
        if (!fg) { failures++; console.error('FAIL 无法解析 ' + name + ': ' + raw); continue; }
        const value = ratio(fg, bg);
        const ok = value >= 4.5;
        if (!ok) failures += 1;
        console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + name.padEnd(22) + raw.padEnd(10) + value.toFixed(2) + ':1');
      }
    }
  }

  // 每个已注册角色的操作/文字强调色也要经过实际表面核算。
  let characterChecks = 0;
  for (const [name, tokens] of characterThemes()) {
    const deep = compositeSurface(tokens, '--bg-deep');
    for (const surface of SURFACES) {
      const bg = compositeSurface(tokens, surface, deep);
      const fg = bg && compositeSurface(tokens, '--accent', bg);
      characterChecks++;
      if (!fg || ratio(fg, bg) < 4.5) {
        failures++;
        console.error('FAIL character ' + name + ' / ' + surface + ': ' + (fg ? ratio(fg, bg).toFixed(2) : 'unresolved'));
      }
    }
  }
  console.log('角色强调色检查: ' + characterChecks + ' 项');

  // SC 1.4.11:非文字图形（图标、状态点、分隔边框）阈值 3:1。
  // AppToast 的四种类型只靠图标颜色区分,浅色主题下曾低到 1.90。
  const NON_TEXT_TOKENS = ['--success', '--warning', '--danger', '--info'];
  let nonTextFailures = 0;
  for (const [themeName, tokens] of themes) {
    const deep = hexToRgb(tokens['--bg-deep']);
    const bg = compositeSurface(tokens, '--bg-elevated', deep) || deep;
    console.log('\n=== ' + themeName + ' theme / 非文字图形 3:1 (--bg-elevated) ===');
    for (const name of NON_TEXT_TOKENS) {
      const raw = resolve(tokens, name, undefined);
      const fg = compositeSurface(tokens, name, bg);
      if (!fg) { nonTextFailures++; console.error('FAIL 无法解析 ' + name); continue; }
      const value = ratio(fg, bg);
      const ok = value >= 3;
      if (!ok) nonTextFailures += 1;
      console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + name.padEnd(22) + raw.padEnd(10) + value.toFixed(2) + ':1');
    }
  }

  console.log('\n未达 AA(4.5:1) 的文字 token: ' + failures + ' 项');
  console.log('未达 3:1 的非文字图形 token: ' + nonTextFailures + ' 项');

  // ---- SFC <style> 块局部文字色（2026-08-29 接入，补组件级盲区）----
  // 令牌全绿不代表组件全绿：各 SFC 里还散落着字面 hex 的 color: 声明，
  // 它们不经过 design-system.css，令牌检查天然看不到。这里补一层：
  // 只查字面 hex 的 `color:`（var()/rgb()/color-mix() 已由令牌/字面量门槛另行把关）。
  // 落点候选 = 全局 4 个表面 + 规则自身声明的背景色（hover 亮底配黑字这类
  // "on-accent" 文字落在规则自己的背景上，不能错杀）。
  // 全部候选落点都低于 4.5:1 才判 FAIL。
  console.log('\n=== SFC <style> 局部文字色（组件级盲区补扫） ===');
  let sfcChecks = 0;
  let sfcFailures = 0;
  let sfcExempt = 0;
  const sfcSurfaces = SURFACES.map((name: any) => ({ name, bg: compositeSurface(dark, name, hexToRgb(dark['--bg-deep'])) })).filter((s: any) => s.bg);

  // 从声明值里解析出可计算的颜色。除字面 hex 外，也解析 rgba() / rgb() /
  // color-mix() / var() 令牌 —— 半透明白字（rgba(255,255,255,.6)）是组件里最常见的
  // 漏网写法，不合成到落点上根本看不出它压线不过。
  const SKIP_VALUES = new Set(['transparent', 'inherit', 'initial', 'unset', 'currentColor', 'none']);
  function declColor(raw: any, parentRgb: any) {
    const value = raw.replace(/!important/g, '').trim();
    if (!value || SKIP_VALUES.has(value)) return null;
    return resolveColor(dark, value, parentRgb);
  }

  for (const file of sources.sfcFiles()) {
    const source = sources.read(file);
    for (const styleMatch of source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
      const baseLine = source.slice(0, styleMatch.index).split('\n').length - 1;
      const styleBody = styleMatch[1];
      for (const rule of styleBody.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
        const ruleBody = rule[2];
        const ownBackgrounds: any[] = [];
        let ownBgUnknown = false; // 规则自身声明了底色但解析不动（动态 var/渐变/图像）
        for (const bg of ruleBody.matchAll(/(?:^|;)\s*(?:background(?:-color)?|backdrop)\s*:\s*([^;}]+)/g)) {
          const rgb = declColor(bg[1], hexToRgb(dark['--bg-deep']));
          if (rgb) ownBackgrounds.push(rgb);
          else if (!SKIP_VALUES.has(bg[1].replace(/!important/g, '').trim())) ownBgUnknown = true;
        }
        // 装饰性渐变/水印：按项目约定显式写 contrast-exempt 并给理由，与动效门禁的
        // compositor-exempt 同一治理思路（可见、可查、可评审），不用通符放行。
        // 标记写在规则的选择器段（选择器与 `{` 之间的注释块）里，只作用于紧随的那条规则，
        // 不会顺带豁免邻居。
        const exempt = /contrast-exempt\s*:/.test(rule[1]);
        if (exempt) sfcExempt += 1;
        for (const decl of ruleBody.matchAll(/(?<![-\w])color\s*:\s*([^;}]+)/g)) {
          const rawValue = decl[1].replace(/!important/g, '').trim();
          if (!/^(#|rgb|hsl|color-mix|var\()/i.test(rawValue)) continue;
          if (exempt || ownBgUnknown) continue; // 落点未知或已声明豁免 —— 不猜、不错杀
          const line = baseLine + styleBody.slice(0, rule.index + rule[1].length + 2 + decl.index).split('\n').length;
          const candidates = sfcSurfaces.map((s: any) => ({ name: s.name, bg: s.bg })).concat(
            ownBackgrounds.map((bg: any, i: any) => ({ name: '规则自身背景#' + (i + 1), bg }))
          );
          // 前景色随落点合成（alpha 值要在具体背景上才算得准），解析不动的跳过
          const results: any[] = [];
          for (const c of candidates) {
            const fg = declColor(rawValue, c.bg);
            if (fg) results.push(ratio(fg, c.bg));
          }
          if (!results.length) continue;
          sfcChecks += 1;
          // 判定语义：规则自身声明了可解析背景 → 文字必然落在它上面，硬判该落点；
          // 没有自身背景 → 落在父级表面但具体是哪个未知，要求 4 个表面全部达标。
          let ok, detail;
          if (ownBackgrounds.length && results[sfcSurfaces.length] !== undefined) {
            ok = results[sfcSurfaces.length] >= 4.5;
            detail = '自身背景 ' + results[sfcSurfaces.length].toFixed(2) + ':1';
          } else {
            const min = Math.min.apply(null, results);
            ok = min >= 4.5;
            detail = '全表面最低 ' + min.toFixed(2) + ':1';
          }
          if (!ok) {
            sfcFailures += 1;
            console.log('  FAIL ' + file + ':' + line + '  color: ' + rawValue + '  ' + detail);
          }
        }
      }
    }
  }
  console.log('  SFC 局部文字色检查 ' + sfcChecks + ' 处，FAIL ' + sfcFailures + ' 处，已豁免 ' + sfcExempt + ' 处');

  return failures + nonTextFailures + sfcFailures;
}

if (require.main === module) {
  const failures = run();
  if (process.argv.includes('--check') && failures) process.exitCode = 1;
}
export = { characterThemes, block, resolveColor, compositeSurface, ratio, themes, run };
