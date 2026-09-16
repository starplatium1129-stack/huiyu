'use strict';


// 设计 token 统一检查：扫描 HTML <style> 块和 CSS 文件中未被 token 替代的硬编码颜色
// 用法: node scripts/maintenance/lint-colors.js
// npm 快捷: npm run lint:colors

let fs: typeof import('fs') = require('fs');
let path: typeof import('path') = require('path');

let HEX_RE = /(?<!#)(?:#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3})\b/g;

// 允许存在的 hex 值（data URLs, design token 初始值, 显式忽略）
let ALLOWED = new Set([
  '#fff', '#FFF', '#000',
  '#f4a6d7', '#f2bb68', '#bba7ff', '#b895ff', '#e7e4ff', '#8b6258',
  '#90d9ff', '#3f93c1',
  '#100d1b', '#171329', '#efedf3', '#f7f6f8',
  '#E8E8F0', '#2C2C3A', '#A8A8C0', '#5A5A6E', '#8C8CA3', '#6F6F80',
  '#17171C', '#FFFFFF', '#ffc1e8',
  '#66BB6A', '#FFA726', '#EF5350', '#42A5F5',
  '#FFD54F', '#F06292', '#81C784', '#64B5F6', '#BA68C8', '#FFB74D',
  '#7656c9', '#ad467f', '#9e3f7b',
  '#e53935',
  '#2E7D32', '#E65100', '#C62828',
  '#FFEBEE', '#FFF3E0', '#E8F5E9',
  '#cf75ab', '#7456a8', '#372c5c', '#b97983', '#72505c', '#33283c',
  '#FF80AB', '#CE93D8', '#AD1457', '#6A1B9A', '#00838F', '#0288D1',
  '#D84315', '#388E3C', '#311B92', '#4FC3F7', '#80DEEA', '#CFD8DC',
  '#37474F', '#7C4DFF', '#B71C1C', '#FF8A65', '#FF80AB',
  '#e85d75', '#8d1732', '#d6a039', '#7a5210',
  '#521b29', '#ffb4c1', '#4b3817', '#ffd489',
  '#17131b', '#8b5cf6',
  '#0d0b14', '#ff75a0', '#ffa3c2', '#a093b5',
  '#FF9EC4', '#FFD3E0', '#FFB86C', '#FFD8A8', '#C8E6C9', '#BBDEFB',
  '#E1BEE7',
  '#81D4FA', '#F48FB1', '#A5D6A7', '#F8BBD0', '#FFCC80',
  '#FFE082', '#FFB300', '#FF8F00', '#FFF8E1', '#F8BBD0', '#EC407A',
  '#FFF0F5', '#F06292', '#4CAF50', '#1E88E5', '#0D47A1', '#E3F2FD',
  '#8E24AA', '#4A148C', '#F3E5F5', '#FFE0B2', '#F57C00', '#E65100',
  '#FFF3E0', '#FFD08B', '#EFC5FF', '#BD5793', '#9B621F', '#8159B5',
  '#68439C', '#D9A4EF',
  '#4D3D67', '#2A233D', '#171422', '#E9DDF4', '#C8B9DF', '#8C789F',
  '#F5F2ED', '#F0ECE6', '#E0DCE6', '#EBE7EE', '#C8C2D0',
  '#23232A', '#2A2A33', '#14141A', '#3A3A46', '#303039', '#4E4E5C',
  '#3F8F55', '#A96C12', '#D94B52', '#327CA8',
  '#ee2a3c', '#a80d1b', '#77717f', '#4a4553',
]);

// 必须扫应用真正加载的样式:src/assets/css + SFC 的 <style> 块。
// 曾经只扫 tools/docs/css,而 SPA 一个字节都不加载它们 —— 于是 ALLOWED 越长越大,
// 把 HomeView/CharacterView 的硬编码渐变当"允许"收了进来。
// 独立发布的审计报告(style-sources.STANDALONE_REPORTS,自带设计系统的静态文档)
// 显式豁免 —— 不被应用加载,不参与应用颜色门槛。
let sources: typeof import('./style-sources') = require('./style-sources');
let scanDirs = ['src', 'docs', 'css'];

// 注释里的 hex 是文档示例（常常正是在解释为什么某个值不合格），不是漂移。
// 逐行把注释内容抹成空格，保留行号与行数。
function stripComments(content: string) {
  let out = content.replace(/\/\*[\s\S]*?\*\//g, function (block: string) {
    return block.replace(/[^\n]/g, ' ');
  });
  return out.split('\n').map(function (line: string) {
    return line.replace(/\/\/.*$/, function (rest: string) { return rest.replace(/[^\n]/g, ' '); });
  }).join('\n');
}

function scanFile(filepath: any) {
  let content: string;
  try {
    content = stripComments(fs.readFileSync(filepath, 'utf8'));
  } catch (e) { return []; }

  let warnings: any[] = [];
  let lines = content.split('\n');

  if (filepath.endsWith('.css')) {
    // Scan entire file
    lines.forEach(function (line: string, i: number) {
      let lineno = i + 1;
      let matches = line.match(HEX_RE);
      if (!matches) return;
      // Skip token definitions
      if (/^\s*--\w/.test(line)) return;
      // Skip color-mix() and rgba()
      if (/color-mix\(|rgba\(/.test(line)) return;
      matches.forEach(function (m: string) {
        if (ALLOWED.has(m)) return;
        warnings.push({ file: filepath, line: lineno, hex: m, text: line.trim().slice(0, 120) });
      });
    });
  } else if (filepath.endsWith('.html') || filepath.endsWith('.vue')) {
    // Extract <style> blocks（.vue 与 .html 同一形态）
    let inStyle = false;
    lines.forEach(function (line: string, i: number) {
      let lineno = i + 1;
      if (/<style\b/i.test(line)) { inStyle = true; return; }
      if (/<\/style>/i.test(line)) { inStyle = false; return; }
      if (!inStyle) return;
      // Skip token definitions
      if (/^\s*--\w/.test(line)) return;
      // Skip color-mix(), rgba(), and data URL comments
      if (/color-mix\(|rgba\(|data:image/.test(line)) return;
      let matches = line.match(HEX_RE);
      if (!matches) return;
      matches.forEach(function (m: string) {
        if (ALLOWED.has(m)) return;
        warnings.push({ file: filepath, line: lineno, hex: m, text: line.trim().slice(0, 120) });
      });
    });
  }

  return warnings;
}

function main() {
  let root = path.join(__dirname, '..', '..');
  let allWarnings: any[] = [];

  scanDirs.forEach(function (dir: any) {
    let dirPath = path.join(root, dir);
    if (!fs.existsSync(dirPath)) return;
    walkDir(dirPath);
  });

  function walkDir(dirPath: string) {
    let entries = fs.readdirSync(dirPath, { withFileTypes: true });
    entries.forEach(function (entry: any) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') return;
      let full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'vendor' && entry.name !== 'archive') walkDir(full);
      } else if (entry.name.endsWith('.html') || entry.name.endsWith('.css') || entry.name.endsWith('.vue')) {
        if (sources.isStandaloneReport(path.relative(root, full))) return;
        allWarnings = allWarnings.concat(scanFile(full));
      }
    });
  }

  let counts: Record<string, any> = {};
  allWarnings.forEach(function (w: any) {
    let key = path.relative(root, w.file);
    counts[key] = (counts[key] || 0) + 1;
  });

  if (allWarnings.length === 0) {
    console.log('  ✅ No hardcoded colors found. All colors use design tokens.');
    return;
  }

  console.log('  ⚠️  ' + allWarnings.length + ' hardcoded hex color(s) found:\n');
  let keys = Object.keys(counts).sort();
  keys.forEach(function (f: any) {
    console.log('  ' + f + ' (' + counts[f] + ')');
    allWarnings
      .filter(function (w: any) { return path.relative(root, w.file) === f; })
      .forEach(function (w: any) {
        console.log('    L' + w.line + ': ' + w.hex + '  →  ' + w.text);
      });
    console.log('');
  });

  console.log('  💡 Run "npm run lint:colors" after making CSS changes.');
  console.log('     See docs/maintenance.md for token reference.');

  // 之前无论发现多少漂移都以 0 退出 —— 等于只是打印,进不了门槛。
  if (process.argv.includes('--check')) process.exitCode = 1;
}

main();
