'use strict';

/**
 * 去原生控件门禁 —— 防止浏览器原生外观回流。
 *
 * 存在的理由：2026-09-22 的收尾把全站原生 <select> 换成
 * `src/components/ui/StudioSelect.vue`、把原生 <audio>/<video controls>
 * 换成 `StudioMediaPlayer.vue`，并把最后两处 window.confirm 收编到 useConfirm。
 * 换掉的动因是原生外观与画室主题不搭（系统皮肤、灰渐变条、蓝色进度、黄底自动填充），
 * 不是功能缺陷；而这类回流很容易在后续迭代里悄悄发生——写新筛选器时 `<select>`
 * 是肌肉记忆，加视频预览时 `controls` 也一样。
 *
 * 判定（只扫应用源码 src/，不扫 docs/、一次性脚本与测试）：
 *   · 模板出现原生 <select> → 失败（改用 StudioSelect）
 *   · 模板出现带 controls 的 <audio>/<video> → 失败（改用 StudioMediaPlayer）
 *   · 逻辑出现 confirm/alert/prompt 调用 → 失败（改用 useConfirm 或项目弹层）
 *   · 原生 title 提示 → 计数并锁「只降不升」（改用 StudioTooltip：原生 title 延迟约 1 秒、
 *     不可主题化、只有 hover 才出，禁用控件上多数浏览器还不响应）
 *   · checkbox/radio 的容器级外观约束由 companion-focus 的浏览器测试验证。
 *
 * 用法: node scripts/tests/test-native-controls.js
 */

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const { test }: typeof import('node:test') = require('node:test');
import assert = require('node:assert/strict');
import { parse as parseSfc } from '@vue/compiler-sfc';
import { parse as parseTemplate, NodeTypes, ElementTypes, type TemplateChildNode } from '@vue/compiler-dom';
const sources: typeof import('../maintenance/style-sources') = require('../maintenance/style-sources');

interface Violation { file: string; line: number; detail: string }

/** src/ 下应用自己的源码：SFC 与 TS 逻辑；测试夹具不属于交付面 */
function appSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(vue|ts)$/.test(entry.name)) continue;
      if (/\.(spec|test)\.ts$/.test(entry.name)) continue;
      out.push(sources.rel(full));
    }
  };
  walk(path.join(sources.ROOT, 'src'));
  return out.sort();
}

/** 注释里的写法不算违规：本门禁本身就是"以后别再写"的证据来源 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('<!--');
}

const applicationSources = appSourceFiles().map(file => ({ file, raw: fs.readFileSync(path.join(sources.ROOT, file), 'utf8') }));

function scan(patterns: { re: RegExp; templateOnly?: boolean }[]): Violation[] {
  const violations: Violation[] = [];
  for (const { file, raw } of applicationSources) {
    const template = file.endsWith('.vue') ? sources.sfcTemplate(raw) : '';
    for (const { re, templateOnly } of patterns) {
      const haystack = templateOnly ? template : raw;
      for (const match of haystack.matchAll(re)) {
        const index = match.index ?? 0;
        const line = haystack.slice(0, index).split('\n').length;
        const text = haystack.split('\n')[line - 1] ?? '';
        if (isCommentLine(text)) continue;
        violations.push({ file, line, detail: match[0].replace(/\s+/g, ' ').trim().slice(0, 90) });
      }
    }
  }
  return violations;
}

const NATIVE_TEMPLATE = /<select[\s>]/g;
const NATIVE_MEDIA = /<(?:audio|video)\b[^>]*\bcontrols\b/g;
const BROWSER_DIALOG = /(?<![\w.$])(?:confirm|alert|prompt)\s*\(/g;

test('templates use the project primitives instead of native controls', () => {
  const violations = scan([
    { re: NATIVE_TEMPLATE, templateOnly: true },
    { re: NATIVE_MEDIA, templateOnly: true },
  ]);

  assert.deepEqual(
    violations.map(v => `${v.file}:${v.line} ${v.detail}`),
    [],
    '原生 <select> 改用 StudioSelect；带 controls 的 <audio>/<video> 改用 StudioMediaPlayer',
  );
});

test('browser dialogs are not used for in-app decisions', () => {
  const violations = scan([
    { re: /(?<![\w.$.])window\.(?:confirm|alert|prompt)\s*\(/g },
    { re: BROWSER_DIALOG },
  ]);

  assert.deepEqual(
    violations.map(v => `${v.file}:${v.line} ${v.detail}`),
    [],
    '应用内确认与提示必须走 useConfirm / 项目弹层：原生弹出框无法主题化，也拿不到焦点流程',
  );
});

// 组件的 title prop 是内容契约，不是浏览器 tooltip。只检查原生元素的模板属性。
// 注释、脚本文本和组件标题不计入；原生 title 必须使用 StudioTooltip。
const TITLE_BASELINE = 0;
function nativeTitles(raw: string, file: string): Violation[] {
  const { descriptor, errors } = parseSfc(raw, { filename: file });
  assert.deepEqual(errors, [], `${file}: SFC must parse before checking native titles`);
  if (!descriptor.template) return [];
  const offset = descriptor.template.loc.start.line - 1;
  const violations: Violation[] = [];
  const visit = (node: TemplateChildNode) => {
    if (node.type !== NodeTypes.ELEMENT) return;
    if (node.tagType === ElementTypes.ELEMENT) {
      for (const prop of node.props) {
        const title = prop.type === NodeTypes.ATTRIBUTE ? prop.name === 'title'
          : prop.name === 'bind' && prop.arg?.type === NodeTypes.SIMPLE_EXPRESSION
            && prop.arg.isStatic && prop.arg.content === 'title';
        if (title) violations.push({ file, line: offset + prop.loc.start.line, detail: `<${node.tag}> ${prop.loc.source}` });
      }
    }
    node.children.forEach(visit);
  };
  parseTemplate(descriptor.template.content).children.forEach(visit);
  return violations;
}

test('native title tooltips only go down', () => {
  const fixture = `<template>
    <ArchiveStatePanel title="Component heading"><button title="Native hint" /></ArchiveStatePanel>
    <archive-state-panel :title="heading" />
    <!-- <button title="Commented hint" /> -->
    <div><button :title="hint" /><span v-bind:title="hint" /></div>
  </template>
  <script setup>const markup = '<button title="Script text" />'</script>`;
  assert.deepEqual(nativeTitles(fixture, 'fixture.vue').map(({ line, detail }) => ({ line, detail })), [
    { line: 2, detail: '<button> title="Native hint"' },
    { line: 5, detail: '<button> :title="hint"' },
    { line: 5, detail: '<span> v-bind:title="hint"' },
  ], 'the parser must distinguish native titles from component props, comments and script strings');
  const violations = applicationSources.filter(({ file }) => file.endsWith('.vue')).flatMap(({ file, raw }) => nativeTitles(raw, file));
  console.log(`原生 title 提示：${violations.length} 处 / 未迁移基线 ${TITLE_BASELINE}`);
  assert.ok(violations.length <= TITLE_BASELINE,
    '原生 title 改用 StudioTooltip：hover 与键盘聚焦均可提示，且跟随主题。\n'
    + violations.map(v => `${v.file}:${v.line} ${v.detail}`).join('\n'));
});
