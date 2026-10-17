'use strict';

/**
 * scripts/maintenance/style-sources.js
 *
 * 样式门槛的唯一取样口。
 *
 * 对比度、字面量、颜色与动效检查共用应用实际加载的样式来源：
 * `src/assets/css/`、各 SFC 的 <style> 块、Tailwind 类与静态文档。
 *
 * 所有门槛必须从这里取文件，新增样式载体也只改这一处。
 */

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const tailwind: typeof import('../lib/tailwind-style-audit') = require('../lib/tailwind-style-audit');

const ROOT = path.resolve(__dirname, '..', '..');

function rel(abs: string) {
  return path.relative(ROOT, abs).split(path.sep).join('/');
}

function walk(dir: string, test: any, includeArchive: any = false) {
  const abs = path.isAbsolute(dir) ? dir : path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out: any[] = [];
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

/** Tailwind also scans TS class maps; tests/declarations are not application UI. */
function utilityScriptFiles() {
  return walk('src', (n: string) => n.endsWith('.ts') && !/\.(?:spec|d)\.ts$/.test(n)).map(rel).sort();
}

/** 仍在服务端直出的静态页（docs/），以及 SPA 入口 */
function staticHtmlFiles() {
  const files: any[] = [];
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

/** 设计系统 token 定义所在的文件（应用加载的那一份） */
const DESIGN_SYSTEM = 'src/assets/css/design-system.css';

export = {
  ROOT,
  rel,
  read,
  appCssFiles,
  sfcFiles,
  utilityScriptFiles,
  staticHtmlFiles,
  legacyDocsCssFiles,
  sfcStyleBlocks,
  DESIGN_SYSTEM,
  ...tailwind,
};
