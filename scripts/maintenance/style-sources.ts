'use strict';

/**
 * scripts/maintenance/style-sources.js
 *
 * 样式门槛的唯一取样口。
 *
 * 存在的理由：2026-07-27 审计发现四个样式门槛（check-contrast / scan-style-literals /
 * test-style-debt / lint-colors）都在读 `css/` 目录，而 Vue SPA 加载的是
 * `src/assets/css/` + 各 SFC 的 <style> 块。门槛全绿，但审计的是一棵应用根本
 * 不加载的树 —— `css/director.css` 等文件当时没有任何页面引用。
 *
 * 所有门槛必须从这里取文件，新增样式载体也只改这一处。
 */

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

function rel(abs: string) {
  return path.relative(ROOT, abs).split(path.sep).join('/');
}

function walk(dir: string, test, includeArchive = false) {
  const abs = path.isAbsolute(dir) ? dir : path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = path.join(abs, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'vendor' || (entry.name === 'archive' && !includeArchive)) continue;
      out.push(...walk(full, test, includeArchive));
    } else if (test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** 应用真正加载的样式表（src/main.ts + 各视图 import） */
function appCssFiles() {
  return walk('src/assets/css', (n: string) => n.endsWith('.css')).map(rel).sort();
}

/** 单文件组件 */
function sfcFiles() {
  return walk('src', (n: string) => n.endsWith('.vue')).map(rel).sort();
}

/** 仍在服务端直出的静态页（docs/），以及 SPA 入口 */
function staticHtmlFiles() {
  const files = [];
  if (fs.existsSync(path.join(ROOT, 'index.html'))) files.push('index.html');
  files.push(...walk('docs', (n: string) => n.endsWith('.html'), true).map(rel).sort());
  return files;
}

/** docs/ 仍在加载的遗留样式表 */
function legacyDocsCssFiles() {
  return walk('css', (n: string) => n.endsWith('.css')).map(rel).sort();
}

function read(relPath: string) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

/** 抽出 SFC 的 <style> 块内容 */
function sfcStyleBlocks(source: string) {
  let css = '';
  for (const match of source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) css += match[1] + '\n';
  return css;
}

/** 抽出 SFC 的 <template> 段 */
function sfcTemplate(source: string) {
  const match = source.match(/<template>([\s\S]*)<\/template>/i);
  return match ? match[1] : '';
}

/**
 * 模板里的内联样式。静态 style="..." 与动态 :style="..." 都要，
 * 因为两者都会绕过 token 体系。
 */
function inlineStyleAttrs(templateSource) {
  const out = [];
  for (const match of templateSource.matchAll(/\s:?style="([^"]*)"/g)) {
    const line = templateSource.slice(0, match.index).split('\n').length;
    out.push({ value: match[1], line, dynamic: match[0].trimStart().startsWith(':') });
  }
  return out;
}

/** 设计系统 token 定义所在的文件（应用加载的那一份） */
const DESIGN_SYSTEM = 'src/assets/css/design-system.css';

/**
 * 独立发布的审计/评估报告：自带设计系统的静态文档，应用一个字节都不加载。
 * 其 <style> 遵循报告自身规范，不计入应用样式的 token 回归预算与颜色门槛。
 * 名单须显式维护：新增自带样式的报告要评审后加入，禁止用通配符放行。
 */
const STANDALONE_REPORTS = new Set([
  'docs/archive/audits/design-audit-2026-08-28.html',
  'docs/archive/audits/design-audit-recheck-2026-08-29.html',
  'docs/archive/audits/engineering-audit-2026-08-28.html',
  // 2026-08-30 UX 审计报告（与前三份同族、自带设计系统）；建报告时漏登记，
  // 合并 followup 后 27 处报告内字面量把应用预算撑爆（54/36），2026-08-31 补录。
  'docs/archive/audits/ux-audit-2026-08-30.html',
  'docs/archive/audits/seven-dimension-audit-2026-08-31.html',
  'docs/research/prompts/arknights-artists-research-2026-08-31.html',
  'docs/archive/audits/workflow-audit-2026-08-31.html',
  // 2026-09-05 完成度复审报告（同族、自带设计系统）
  'docs/archive/audits/completion-audit-2026-09-05.html',
]);

function isStandaloneReport(relPath: string) {
  return STANDALONE_REPORTS.has(relPath.split(path.sep).join('/'));
}

export = {
  docsScriptFiles: () => walk('docs', (n: string) => n.endsWith('.js'), true).map(rel).sort(),
  ROOT,
  rel,
  read,
  appCssFiles,
  sfcFiles,
  staticHtmlFiles,
  legacyDocsCssFiles,
  sfcStyleBlocks,
  sfcTemplate,
  inlineStyleAttrs,
  DESIGN_SYSTEM,
  isStandaloneReport,
};
