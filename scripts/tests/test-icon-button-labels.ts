'use strict';

/**
 * 图标唯一按钮必须有可访问名（WCAG 4.1.2 / 1.1.1）
 *
 * 存在的理由：本项目图标是纯手绘线条 SVG（ArchiveIcon），按钮常常「只有一个图标、
 * 没有文字」。这类按钮若不带 aria-label，读屏只会念「按钮」，键盘/辅助技术用户
 * 无从判断作用。2026-08-29 复审计补做全量核对时才发现：此前「aria-label 覆盖
 * 率 41%」的说法是**测量口径错误**——它把 `{{ }}` 插值文本当非文本、且漏算
 * title 属性。真实口径下图标唯一按钮无一漏网，故把口径本身固化成门禁，
 * 防的是「以后新增时漏掉」，不是补历史欠账。
 *
 * 判定：
 *   · 有可见文本（含插值）→ 无需 aria-label，跳过
 *   · 无文本 + aria-label/aria-labelledby → 通过
 *   · 无文本 + 仅 title → 告警（title 可提供可访问名，但触屏与读屏表现不稳定）
 *   · 无文本 + 什么都没有 → 失败
 *
 * 用法: node scripts/tests/test-icon-button-labels.js
 */

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const { test }: typeof import('node:test') = require('node:test');
import assert = require('node:assert/strict');
const sources: typeof import('../maintenance/style-sources') = require('../maintenance/style-sources');

function walk(dir: string, out: string[]): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.vue')) out.push(full);
  }
  return out;
}

/** 按钮内容里「能念出来的东西」：插值算文本，纯标签不算 */
function visibleText(innerHtml: string): string {
  return innerHtml
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\{\{[\s\S]*?\}\}/g, 'X')
    .replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function collect() {
  const files = walk(path.join(sources.ROOT, 'src'), []);
  const failures = [];
  const warnings = [];
  let buttons = 0;
  let iconOnly = 0;

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/<button\b([\s\S]*?)<\/button>/g)) {
      buttons += 1;
      const openTag = match[1].slice(0, match[1].indexOf('>'));
      const inner = match[1].slice(match[1].indexOf('>') + 1);
      if (visibleText(inner)) continue;               // 有可见文字，可访问名天然存在
      if (!/ArchiveIcon|<svg/i.test(inner)) continue; // 既无文字又无图标（纯装饰），不归本门禁管
      iconOnly += 1;
      const line = source.slice(0, match.index).split('\n').length;
      const rel = path.relative(sources.ROOT, file).split(path.sep).join('/');
      const where = rel + ':' + line;
      if (/aria-label|aria-labelledby/.test(openTag)) continue;
      if (/\btitle=/.test(openTag)) warnings.push(where);
      else failures.push(where);
    }
  }
  return { buttons, iconOnly, failures, warnings };
}

test('图标唯一按钮必须带可访问名', () => {
  const { buttons, iconOnly, failures, warnings } = collect();
  console.log('  按钮总数 ' + buttons + '，其中图标唯一 ' + iconOnly + ' 个；缺少可访问名 ' + failures.length + ' 个，仅靠 title ' + warnings.length + ' 个');
  for (const w of warnings) console.log('    WARN ' + w + '  建议补 aria-label（title 在触屏/读屏下不稳定）');
  for (const f of failures) console.log('    FAIL ' + f + '  图标唯一按钮无 aria-label/aria-labelledby');
  assert.deepEqual(failures, [], '存在无名称的图标按钮');
});
