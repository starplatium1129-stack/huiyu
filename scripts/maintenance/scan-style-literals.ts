'use strict';
// 一次性巡检:统计页内 <style> 块里尚未收敛到 token 的字面量。
// 用法: node scripts/maintenance/scan-style-literals.js [file...]
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const sources: typeof import('./style-sources') = require('./style-sources');
const root = sources.ROOT;

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
// 必须覆盖应用真正加载的样式:src/assets/css/*.css + 各 SFC 的 <style> 块。
// 曾经这里只扫 css/ + tools/ + docs/,而 SPA 一个字节都不加载 css/。
// 独立发布的审计报告(见 style-sources.STANDALONE_REPORTS)是自带设计系统的
// 静态文档,不占用应用 token 回归预算,显式豁免。
const targets = args.length
  ? args
  : [...sources.appCssFiles(), ...sources.sfcFiles(),
     ...sources.staticHtmlFiles(), ...sources.legacyDocsCssFiles()]
    .filter((f) => !sources.isStandaloneReport(f));

// 已在源文件里写注释说明理由的合理例外(根字号基准、品牌图形圆角、
// iOS 16px 约束、装饰性字形槽、卡内堆叠底层)。总量作为回归预算使用。
// 2026-07-27:门槛改为扫真实样式树后按实测重设；2026-08-15 保持回归门禁。
const BUDGET = 36;

const CHECKS = [
  ['fontsize', /font-size:\s*\.?\d[\d.]*(?:rem|px)/g],
  ['font-shorthand', /font:\s*[^;{}]*?\s\.?\d[\d.]*(?:rem|px)/g],
  ['radius', /border-radius:\s*[\d.]+px/g],
  ['zindex', /z-index:\s*-?\d+/g],
  ['white', /rgba\(\s*255,\s*255,\s*255/g],
  ['black', /rgba\(\s*0,\s*0,\s*0/g],
  ['pill', /\b9{2,4}px\b/g],
  ['bezier', /cubic-bezier\(/g]
];

let grand = 0;
const rows = [];
for (const rel of targets) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) { console.log('  (missing) ' + rel); continue; }
  const raw = fs.readFileSync(abs, 'utf8');
  let css = rel.endsWith('.css') ? raw : sources.sfcStyleBlocks(raw); // .vue 与 .html 的 <style> 块同一形态
  css = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
  // token 定义行本身就是字面量的合法归宿(--accent-soft: rgba(...)),不算漂移。
  // 只统计"使用点"的字面量。
  css = css.split('\n').filter((line) => !/^\s*--[\w-]+\s*:/.test(line)).join('\n');
  const counts = {};
  let total = 0;
  for (const [name, re] of CHECKS) {
    const n = (css.match(re) || []).length;
    if (n) { counts[name] = n; total += n; }
  }
  if (total) rows.push([rel, total, counts]);
  grand += total;
}

rows.sort((a, b) => b[1] - a[1]);
for (const [rel, total, counts] of rows) {
  const detail = Object.entries(counts).map(([k, v]) => k + '=' + v).join(' ');
  console.log('  ' + String(total).padStart(4) + '  ' + rel.padEnd(30) + detail);
}
console.log('TOTAL literal occurrences: ' + grand + ' (budget ' + BUDGET + ')');

if (process.argv.includes('--check')) {
  if (grand > BUDGET) {
    console.error('样式字面量超出预算:新增了 ' + (grand - BUDGET) + ' 处未走 token 的字面量。');
    console.error('请改用 --fs-* / --r-* / --z-* / --s-* token;确有必要的例外请写注释并调整 BUDGET。');
    process.exit(1);
  }
  console.log('字面量预算检查通过。');
}
