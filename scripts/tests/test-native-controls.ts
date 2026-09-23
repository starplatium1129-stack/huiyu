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
 *   · 原生 checkbox/radio 只计数不阻断（native-controls.css 仍为其提供主题外观，
 *     但 apple-hig-accessibility / companion-focus 要求指定容器内为 0）
 *
 * 用法: node scripts/tests/test-native-controls.js
 */

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const { test }: typeof import('node:test') = require('node:test');
import assert = require('node:assert/strict');
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

function scan(patterns: { re: RegExp; templateOnly?: boolean }[]): { violations: Violation[]; counts: Map<string, number> } {
  const violations: Violation[] = [];
  const counts = new Map<string, number>();
  for (const file of appSourceFiles()) {
    const raw = fs.readFileSync(path.join(sources.ROOT, file), 'utf8');
    const template = file.endsWith('.vue') ? sources.sfcTemplate(raw) : '';
    for (const { re, templateOnly } of patterns) {
      const haystack = templateOnly ? template : raw;
      for (const match of haystack.matchAll(re)) {
        const index = match.index ?? 0;
        const line = haystack.slice(0, index).split('\n').length;
        const text = haystack.split('\n')[line - 1] ?? '';
        if (isCommentLine(text)) continue;
        counts.set(re.source, (counts.get(re.source) || 0) + 1);
        violations.push({ file, line, detail: match[0].replace(/\s+/g, ' ').trim().slice(0, 90) });
      }
    }
  }
  return { violations, counts };
}

const NATIVE_TEMPLATE = /<select[\s>]/g;
const NATIVE_MEDIA = /<(?:audio|video)\b[^>]*\bcontrols\b/g;
const BROWSER_DIALOG = /(?<![\w.$])(?:confirm|alert|prompt)\s*\(/g;
const NATIVE_PICKERS = /<input\b[^>]*type="(?:checkbox|radio)"/g;

test('templates use the project primitives instead of native controls', () => {
  const { violations } = scan([
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
  const { violations } = scan([
    { re: /(?<![\w.$.])window\.(?:confirm|alert|prompt)\s*\(/g },
    { re: BROWSER_DIALOG },
  ]);

  assert.deepEqual(
    violations.map(v => `${v.file}:${v.line} ${v.detail}`),
    [],
    '应用内确认与提示必须走 useConfirm / 项目弹层：原生弹出框无法主题化，也拿不到焦点流程',
  );
});

test('native checkbox and radio usage stays counted', () => {
  const { counts } = scan([{ re: NATIVE_PICKERS, templateOnly: true }]);
  const total = counts.get(NATIVE_PICKERS.source) ?? 0;

  // 只报告不阻断：这一项是 e2e 的容器级约束（外观对话框、桌宠设置面板要求为 0），
  // 全库数量变化本身不是回归，但审计时需要这个数字在手。
  console.log(`原生 checkbox/radio：${total} 处（允许，需双主题视觉验收）`);
  assert.ok(total >= 0);
});

// 原生 title 提示的未迁移存量：从 177 处清零至 35 处（剩余 35 处均为 Vue 组件自定义属性：
// ArchiveStatePanel 29 处、WorkspaceArchiveBar 3 处、ModelCalibrationFields 3 处；
// 原生 HTML 元素上的 title 提示已完全清零）。
// 它是浏览器原生外观里最后一大块，而且行为也改不动：出现延迟约 1 秒、无法主题化、
// 只有 hover 才出（键盘与触屏用户拿不到）、禁用控件上多数浏览器连 hover 都不响应。
// 替代品是 StudioTooltip（hover 与聚焦都触发、跟随双主题令牌、dialog 内自动改写 portal）。
// 这里锁成「只降不升」：迁移一批就把这个数字改小，不允许新增原生 title。
const NATIVE_TITLE = /(?<![\w-]):?title="/g;
const TITLE_BASELINE = 35;

test('native title tooltips only go down', () => {
  const { counts } = scan([{ re: NATIVE_TITLE }]);
  const total = counts.get(NATIVE_TITLE.source) ?? 0;

  console.log(`原生 title 提示：${total} 处 / 未迁移基线 ${TITLE_BASELINE}`);
  assert.ok(
    total <= TITLE_BASELINE,
    `原生 title 从 ${TITLE_BASELINE} 涨到 ${total}：改用 StudioTooltip —— hover 与键盘聚焦都出提示，`
    + '跟随双主题令牌，且在 dialog 内不会被弹窗盖住（迁完一批请把 TITLE_BASELINE 同步调小）',
  );
});
