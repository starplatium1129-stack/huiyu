'use strict';
/**
 * lint-animations.js —— 动效合成器铁律门禁（2026-08-27 审计立项）
 *
 * AGENTS.md 红线：高频动画与过渡必须使用 GPU 合成属性（transform / opacity），
 * 严禁 left/top/width/height 等布局属性做补间引发主线程逐帧重排（Reflow）。
 * 该铁律此前 100% 靠人工自觉，审计确认无任何自动检查，且存量已有实锤违规
 * （含 chat.css eqPulse 用 height 做「无限循环」语音 EQ 动画）。
 *
 * 扫描真实样式树（style-sources.js 唯一取样口，SPA 加载的部分）：
 *   1. transition / transition-property 值中出现的布局属性（按逗号分项取首 token）；
 *   2. @keyframes 步进块内部的布局属性声明。
 *
 * 豁免机制：确有必要保留的存量场景，必须在违规声明的紧邻上方注释写明：
 *     /* compositor-exempt: <为什么 transform/opacity 方案不可接受的理由> *⁠/
 * 每一处豁免都要能通过评审追问；未带豁免的违规一律失败。基线 ALLOWED_EXEMPT
 * 是当前已豁免总量：新增豁免必须同步上调此数并说明理由；修掉存量后请下调，
 * 让预算只反映真实的遗留债。legacy css/docs 树不在本门禁域内（铁律针对的是
 * SPA 高频 UI，与 style-sources 取样口径的差异在此显式声明而非隐式遗漏）。
 */

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const sources: typeof import('./style-sources') = require('./style-sources');
const root = sources.ROOT;

// 当前获准保留的豁免数（2026-08-27 立项时基线）：
// 1. design-system.css .meter-fill width —— scaleX 会压扁圆头并把子扫光伪元素横向拉伸；
// 2. SceneExplorerView.vue .ex-more max-height —— hover 一次性展开（非高频），grid/JS 测高方案成本高于收益；
// 3. CharacterView.vue .bg-story height —— 展开长文阅读辅助，interpolate-size 渐进增强，点击一次性。
// 4. design-system.css .anim-collapse-grid grid-template-rows —— 折叠容器高度未知，
//    grid 0fr→1fr 是唯一免 JS 测高的纯 CSS 方案（scaleY 压扁文字、max-height 要魔法值）；
//    一次性展开非高频。2026-08-28 补检发现：此前该属性不在检测名单内，属漏检。
const ALLOWED_EXEMPT = 3;

const MARKER = 'compositor-exempt';

// transition 值里属性名不带冒号（"width 0.08s ease-out"），须按名比对；
// 不含 line-height（文字排版微调几乎不构成逐帧动画热路径）、border-*width（罕见且易误报）。
const KEYFRAME_LAYOUT_DECL = /(?:^|[\s;{(])((?:max|min)-(?:width|height)|(?:margin|padding)(?:-(?:top|bottom|left|right))?|grid-template-(?:rows|columns)|(?:width|height|top|bottom|left|right))\s*:/g;
const TRANSITION_DECL = /transition(?:-property)?\s*:\s*([^;{}]+)/g;
const KEYFRAMES_BLOCK = /@(?:-\w+-)?keyframes\s+[\w-]+\s*\{/g;
const SHORTHAND_PARTS = /^(max|min)-(width|height)$/;

// 重绘型属性：不触发逐帧重排（Reflow），但会触发逐帧重绘（Repaint），
// filter / backdrop-filter 还要额外的离屏合成，实测开销不比布局属性低。
// 2026-08-28 审计前，这三类完全不在门禁视野内 —— 布局门禁全绿，但项目里
// 躺着 29 处 box-shadow 与 14 处 filter 过渡。这里单独统计为「警告」：
// 打印清单、不阻断 CI、不计入 ALLOWED_EXEMPT（那套基线是给"不得不用且已
// 逐个评审过的布局补间"留的，不应被重绘型稀释）。
const REPAINT_NAMES = ['box-shadow', 'filter', 'backdrop-filter', 'background-position', 'background-size'];
// keyframes 里的重绘型声明：此前门禁只扫 keyframes 的布局属性，于是
// 「无限循环 + box-shadow 涟漪」这类每帧重绘的常驻动画一直躺在盲区
// （2026-08-29 实测抓出 atelierPulse / pulse-dot 两处）。
const KEYFRAME_REPAINT_DECL = new RegExp('(?:^|[\\s;{])(' + REPAINT_NAMES.join('|') + ')\\s*:', 'g');

function isLayoutName(token) {
  const name = token.replace(/!important$/i, '').trim().toLowerCase();
  if (!name || name === 'all' || name === 'none' || name.startsWith('--')) return false;
  if (SHORTHAND_PARTS.test(name)) return true;
  if (/^(margin|padding)(-(top|bottom|left|right))?$/.test(name)) return true;
  // grid-template-rows/columns 是逐帧重排属性，此前漏检
  // （design-system.css 的 .anim-collapse-grid 靠它做折叠动画，门禁却放过）。
  if (/^grid-template-(rows|columns)$/.test(name)) return true;
  return ['width', 'height', 'top', 'bottom', 'left', 'right'].includes(name);
}

function isRepaintName(token) {
  const name = token.replace(/!important$/i, '').trim().toLowerCase();
  return REPAINT_NAMES.includes(name);
}

function findExemption(text, index) {
  // 豁免标记在违规点前 ~700 字符内（个别超长单行规则整行近 500 字符，
  // 标记写在紧邻上一行也要能命中）或声明同段后 200 字符内均有效。
  const before = text.slice(Math.max(0, index - 700), index);
  const after = text.slice(index, index + 200);
  return before.includes(MARKER) || after.includes(MARKER);
}

function snippetOf(text, index) {
  const lineStart = text.lastIndexOf('\n', Math.max(0, index - 1)) + 1;
  const raw = text.slice(lineStart).split('\n').slice(0, 3).join(' ').trim();
  return raw.length > 90 ? `${raw.slice(0, 90)}…` : raw;
}

function scanTransitionValue(css, match) {
  // "width 0.08s ease, height 0.1s" → 每个逗号项的首 token 即补间属性名
  for (const item of match[1].split(',')) {
    const lead = item.trim().split(/[\s]+/)[0];
    if (isLayoutName(lead || '')) {
      return { kind: 'transition', snippet: snippetOf(css, match.index), exempt: findExemption(css, match.index) };
    }
  }
  return null;
}

function scanCss(relPath, css) {
  const findings = [];

  for (const match of css.matchAll(TRANSITION_DECL)) {
    const hit = scanTransitionValue(css, match);
    if (hit) findings.push(hit);
    // 重绘型逐项统计：一个 transition 里可能同时有 box-shadow 和 filter
    for (const item of match[1].split(',')) {
      const lead = item.trim().split(/\s+/)[0];
      if (isRepaintName(lead || '')) {
        findings.push({
          kind: `transition(${lead})`,
          snippet: snippetOf(css, match.index),
          exempt: true,
          warnOnly: true,
          // 直接记属性名：snippet 是截断的，反推会大量落进"其他"
          repaintProp: lead,
        });
      }
    }
  }

  for (const open of css.matchAll(KEYFRAMES_BLOCK)) {
    // 大括号配平取出整个 keyframes 体（百分比步进块内的属性声明才是补间目标）
    let depth = 1;
    let end = open.index + open[0].length;
    while (end < css.length && depth > 0) {
      if (css[end] === '{') depth += 1;
      else if (css[end] === '}') depth -= 1;
      end += 1;
    }
    const body = css.slice(open.index, end);
    const name = open[0].replace(/^@\S+\s+/, '').replace(/[{\s]/g, '');
    for (const match of body.matchAll(KEYFRAME_LAYOUT_DECL)) {
      findings.push({
        kind: `@keyframes ${name}(${match[1]})`,
        snippet: snippetOf(body, match.index),
        exempt: findExemption(body, match.index),
      });
    }
    // 无限循环的重绘型动画是真热点（每帧都在跑），单独标注出来便于定位
    const infinite = new RegExp('animation[^;}]*\\b' + name + '\\b[^;}]*infinite').test(css);
    for (const match of body.matchAll(KEYFRAME_REPAINT_DECL)) {
      findings.push({
        kind: `@keyframes ${name} · ${infinite ? '无限循环' : '有限次'}(${match[1]})`,
        snippet: snippetOf(body, match.index),
        exempt: findExemption(body, match.index),
        warnOnly: true,
        repaintProp: `${match[1]} @keyframes${infinite ? '·无限循环' : ''}`,
      });
    }
  }

  return findings.map(f => ({ file: relPath, ...f }));
}

function collect() {
  const targets = [...sources.appCssFiles(), ...sources.sfcFiles()];
  const all = [];
  for (const relPath of targets) {
    const abs = path.join(root, relPath);
    if (!fs.existsSync(abs)) continue; // 与 scan-style-literals 同口径：缺失仅提示不阻断
    const raw = fs.readFileSync(abs, 'utf8');
    const css = relPath.endsWith('.vue') ? sources.sfcStyleBlocks(raw) : raw;
    all.push(...scanCss(relPath, css));
  }
  return all;
}

function report(findings) {
  const gate = findings.filter(f => !f.warnOnly);
  const warns = findings.filter(f => f.warnOnly);

  if (!gate.length) {
    console.log('动效合成器检查通过：真实样式树无布局属性补间。');
  } else {
    console.log('布局属性补间清单（transform/opacity 以外的过渡/关键帧补间）：');
    for (const f of gate.sort((a, b) => Number(a.exempt) - Number(b.exempt))) {
      console.log(`  [${f.exempt ? '豁免' : '违规'}] ${f.file} · ${f.kind}`);
      console.log(`          ${f.snippet}`);
    }
    console.log(`TOTAL ${gate.length} 处，其中已豁免 ${gate.filter(f => f.exempt).length} 处 / 基线 ${ALLOWED_EXEMPT}`);
  }

  if (warns.length) {
    console.log(`\n重绘型过渡 ${warns.length} 处（不阻断：会逐帧重绘，filter 还需离屏合成）：`);
    const byProp = new Map();
    const byFile = new Map();
    for (const f of warns) {
      const prop = f.repaintProp || '其他';
      byProp.set(prop, (byProp.get(prop) || 0) + 1);
      byFile.set(f.file, (byFile.get(f.file) || 0) + 1);
    }
    for (const [prop, n] of [...byProp].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${prop.padEnd(18)} ${n} 处`);
    }
    const hot = [...byFile].sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (hot.length) {
      console.log('  集中文件：');
      for (const [file, n] of hot) console.log(`    ${n} 处  ${file}`);
    }
    console.log('  整改方向：改用 transform/opacity 表达，或把变化挪到伪元素/静态图层上。');
  }
}

function main() {
  const findings = collect();
  report(findings);

  if (!process.argv.includes('--check')) return;

  // 警告项（重绘型）不参与门禁判定：它是改进清单，不是失败条件
  const gate = findings.filter(f => !f.warnOnly);
  const violations = gate.filter(f => !f.exempt);
  if (violations.length) {
    console.error(`\n动效铁律违规 ${violations.length} 处：布局属性不得用于补间，请改用 transform/opacity；`);
    console.error(`确有必要的例外请在违规声明上方写 /* ${MARKER}: <理由> */ 并评审上调 ALLOWED_EXEMPT。`);
    process.exit(1);
  }
  const exempted = gate.length;
  if (exempted > ALLOWED_EXEMPT) {
    console.error(`\n豁免总数 ${exempted} 超过基线 ${ALLOWED_EXEMPT}：新增豁免必须同步上调 ALLOWED_EXEMPT 并在代码评审说明理由。`);
    process.exit(1);
  }
  if (exempted < ALLOWED_EXEMPT) {
    console.warn(`\n[warn] 存量豁免减少为 ${exempted}（基线 ${ALLOWED_EXEMPT}）：还清了债就把 ALLOWED_EXEMPT 一并下调。`);
  }
  console.log('动效合成器铁律门禁通过。');
}

main();

export = { isLayoutName, scanCss, collect };
