import { errorMessage as runtimeErrorMessage } from '../lib/runtime-errors';
import ts from 'typescript';
import { bindsOnlyCustomProps } from '../lib/style-carriers';
'use strict';

// 样式债门禁 —— 防止本次全局美术校准的成果回归。
// 用法: node scripts/tests/test-style-debt.js
//
// 覆盖三件事:
//   1. HTML 内联 style 预算(只允许自定义属性载体,如 style="--fill:80%")
//   2. docs/ 也必须 CSP 就绪(原门禁只覆盖 tools/,导致 docs 长期存在 inline handler)
//   3. 设计 token 的完整性(被引用但未定义 = 运行时静默失效)

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const sources: typeof import('../maintenance/style-sources') = require('../maintenance/style-sources');

const { test }: typeof import('node:test') = require('node:test');

// Inspect property names independently of their values: template interpolation
// and nested expressions can contain braces without ending the style object.
function dynamicCustomPropsOnly(value: string): boolean {
  const tree = ts.createSourceFile('inline-style.ts', `(${value})`, ts.ScriptTarget.Latest, true);
  const statement = tree.statements[0];
  if (tree.statements.length !== 1 || !statement || !ts.isExpressionStatement(statement)) return false;
  let expression = statement.expression;
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  if (!ts.isObjectLiteralExpression(expression) || !expression.properties.length
    || expression.getLastToken(tree)?.kind !== ts.SyntaxKind.CloseBraceToken) return false;
  return expression.properties.every(property => {
    if (!ts.isPropertyAssignment(property) || !property.initializer.getWidth(tree)) return false;
    const name = ts.isComputedPropertyName(property.name) ? property.name.expression : property.name;
    return ts.isStringLiteralLike(name) && /^--[\w-]+$/.test(name.text);
  });
}

test('dynamic style carriers accept custom-property keys with template and nested values', () => {
  const assert: typeof import('node:assert/strict') = require('node:assert/strict');
  for (const value of [
    "{ '--sample-ratio': entry.width && entry.height ? `${entry.width} / ${entry.height}` : '3 / 4' }",
    "{ '--fill': enabled ? '80%' : '0', '--opacity': values[index] ?? '1' }",
    "({ ['--offset']: ({ value: '}' }).value, '--color': color })",
  ]) assert.equal(dynamicCustomPropsOnly(value), true, value);
  assert.equal(bindsOnlyCustomProps(`
    const host = useAtmosphere();
    function useAtmosphere() { const style = computed(() => theme()); return style; }
    function theme() { return { '--accent': color, '--aura': nested.value } as CSSProperties; }
  `, 'host'), true);
});

test('dynamic style carriers reject ordinary keys, unknown computed keys and spreads', () => {
  const assert: typeof import('node:assert/strict') = require('node:assert/strict');
  for (const value of [
    "{ '--fill': '80%', color: 'red' }", "{ color: 'red', '--fill': '80%' }",
    "{ '--fill': '80%', ['opacity']: 1 }", "{ [property]: value }",
    "{ '--fill': '80%', ...otherStyles }", "{ get '--fill'() { return '80%' } }",
    "{ '--fill': }", "{ '--fill': '80%'", "[ { '--fill': '80%' }, otherStyles ]",
  ]) assert.equal(dynamicCustomPropsOnly(value), false, value);
  for (const object of ["{ '--accent': color, opacity: 1 }", "{ '--accent': color, ...other }", "{ [key]: color }"]) {
    assert.equal(bindsOnlyCustomProps(`
      const host = useAtmosphere();
      function useAtmosphere() { const style = computed(() => theme()); return style; }
      function theme() { return ${object}; }
    `, 'host'), false, object);
  }
  for (const body of [
    'function useAtmosphere(style) { return style; }',
    'function useAtmosphere({ style }) { return style; }',
    'function useAtmosphere() { const { style } = incoming; return style; }',
    'function useAtmosphere() { const style = incoming; return style; }',
    "function useAtmosphere() { function inner() { const hidden = { '--accent': color }; } return hidden; }",
    "function useAtmosphere(computed) { return computed(() => ({ '--accent': color })); }",
  ]) assert.equal(bindsOnlyCustomProps(`
    const style = { '--accent': color };
    const host = useAtmosphere(incoming);
    ${body}
  `, 'host'), false, body);
});

test('style arrays recursively resolve only proven custom-property carriers', () => {
  const assert: typeof import('node:assert/strict') = require('node:assert/strict');
  const source = `
    const theme = computed(() => ({ '--accent': color }));
    const layout = useLayout();
    function useLayout() {
      const style = computed(() => expanded ? { '--width': width } : {});
      return { style, resize };
    }
    const unsafe = computed(() => ({ color: 'red' }));
    const unknown = incoming;
  `;
  for (const binding of ['[theme, layout.style.value]', '[theme, [{ "--fill": value }, layout.style.value]]',
    '[{ style: { "--fill": value } }.style]', 'enabled ? { "--fill": value } : undefined']) {
    assert.equal(bindsOnlyCustomProps(source, binding), true, binding);
  }
  for (const binding of ['[theme, unknown]', '[theme, unsafe]', '[theme, { opacity: 1 }]',
    '[theme, ...unknown]', '[theme, layout.missing.value]', '[theme, layout[key]]', '[theme, , layout.style.value]',
    '[theme, enabled ? layout.style.value : unsafe]', 'enabled ? { opacity: 1 } : undefined',
    'undefined.style', '[theme', '[{ "--fill": value',
    '[{ style: theme, style: unknown }.style]']) {
    assert.equal(bindsOnlyCustomProps(source, binding), false, binding);
  }
  assert.equal(bindsOnlyCustomProps(`${source}\nconst replaced = { ...unknown, style: theme };`, '[theme, replaced.style]'), false);
  assert.equal(bindsOnlyCustomProps('const undefined = { opacity: 1 };', 'enabled ? { "--fill": value } : undefined'), false);
});

test("style-debt", () => {
const root = sources.ROOT;
const failures: string[] = [];

function fail(message: string) { failures.push(message); }

const htmlFiles = sources.staticHtmlFiles();
const sfcFiles = sources.sfcFiles();

// ---- 1. 内联 style 预算 ----------------------------------------------------
// 允许的唯一形态:自定义属性载体。值属于数据(评分/比例/进度),样式规则仍在 CSS 里。
const CUSTOM_PROP_ONLY = /^\s*(--[\w-]+\s*:\s*[^;]+;?\s*)+$/;

// Follow local imports to the binding's helper, resolving each path from its own module.
function styleCarrierSearchScope(absPath: string, source: string) {
  const visited = new Set<string>();
  const chunks: string[] = [];
  const visit = (file: string, text: string, depth: number): void => {
    if (visited.has(file)) return;
    visited.add(file);
    const script = file.endsWith('.vue')
      ? [...text.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]).join('\n') : text;
    chunks.push(script);
    if (depth === 3) return;
    const tree = ts.createSourceFile(file, script, ts.ScriptTarget.Latest, true);
    for (const statement of tree.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const spec = statement.moduleSpecifier.text;
      const resolved = spec.startsWith('.') ? path.resolve(path.dirname(file), spec)
        : spec.startsWith('@/') ? path.join(root, 'src', spec.slice(2)) : null;
      if (!resolved) continue;
      for (const ext of ['.ts', '.js']) {
        const target = resolved + ext;
        if (fs.existsSync(target)) { visit(target, fs.readFileSync(target, 'utf8'), depth + 1); break; }
      }
    }
  };
  visit(absPath, source, 0);
  return chunks.join('\n');
}

for (const rel of htmlFiles) {
  const source = fs.readFileSync(path.join(root, rel), 'utf8');
  const matches = [...source.matchAll(/\sstyle="([^"]*)"/g)];
  for (const match of matches) {
    if (CUSTOM_PROP_ONLY.test(match[1])) continue;
    const line = source.slice(0, match.index).split('\n').length;
    fail(`${rel}:${line} 内联 style 必须换成全局 class 或自定义属性载体 → style="${match[1]}"`);
  }
}

// SFC 模板同样受约束 —— 这是过去完全没被覆盖的地方(实测 19 处违规)
for (const rel of sfcFiles) {
  const source = fs.readFileSync(path.join(root, rel), 'utf8');
  const template = sources.sfcTemplate(source);
  if (!template) continue;
  // 模板在 SFC 里的起始行,用于把模板内行号换算成文件行号
  const templateStartLine = source.slice(0, source.indexOf(template)).split('\n').length - 1;
  for (const attr of sources.inlineStyleAttrs(template)) {
    if (attr.dynamic) {
      if (dynamicCustomPropsOnly(attr.value)) continue;
      if (bindsOnlyCustomProps(styleCarrierSearchScope(path.join(root, rel), source), attr.value)) continue;
    } else if (CUSTOM_PROP_ONLY.test(attr.value)) continue;
    const prefix = attr.dynamic ? ':style' : 'style';
    fail(`${rel}:${templateStartLine + attr.line} 内联 ${prefix} 必须换成 scoped class 或自定义属性载体 → ${prefix}="${attr.value}"`);
  }
}

// ---- 2. CSP 就绪:全站(含 docs/)零 inline handler、零内嵌控制器 ------------
const inlineHandlerRe = /\son(?:click|change|input|submit|keydown|keyup|focus|blur|error)\s*=/i;

for (const rel of htmlFiles) {
  const source = fs.readFileSync(path.join(root, rel), 'utf8');
  if (inlineHandlerRe.test(source)) {
    fail(`${rel} 不得使用 HTML 事件属性(onclick 等),改用外置控制器 + addEventListener`);
  }
  const inlineScripts = [...source.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((match) => !/\bsrc\s*=/.test(match[1]) && match[2].trim().length > 0);
  if (inlineScripts.length) {
    fail(`${rel} 不得内嵌 <script> 控制器(${inlineScripts.length} 处),抽成外部带版本号的脚本`);
  }
}

// docs/ 抽出的控制器必须是可解析的普通脚本,且不得再输出 inline handler
const jsInlineHandlerRe = /(?:^|[\s"'`])on(?:click|change|input|submit|keydown|keyup|focus|blur|error)\s*=/;
const docsDir = path.join(root, 'docs');
if (fs.existsSync(docsDir)) {
  for (const rel of sources.docsScriptFiles()) {
    const source = fs.readFileSync(path.join(root, rel), 'utf8');
    if (jsInlineHandlerRe.test(source)) fail(`${rel} 不得输出内联事件属性`);
    try {
      new ((require('vm') as typeof import('vm')).Script)(source, { filename: rel });
    } catch (error) {
      fail(`${rel} 语法错误: ${runtimeErrorMessage(error)}`);
    }
  }
}

// ---- 3. 设计 token 完整性 --------------------------------------------------
// 被 var() 引用但从未定义 = 静默失效(浏览器不报错,元素直接掉样式)。
// 必须覆盖应用真正加载的 src/assets/css + 所有 SFC。
const cssFiles = [...sources.appCssFiles(), ...sources.legacyDocsCssFiles()];

let allCss = '';
for (const rel of cssFiles) allCss += fs.readFileSync(path.join(root, rel), 'utf8') + '\n';
let allInlineCss = '';
for (const rel of [...htmlFiles, ...sfcFiles]) {
  const source = fs.readFileSync(path.join(root, rel), 'utf8');
  for (const match of source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) allInlineCss += match[1] + '\n';
  // 自定义属性载体里赋的值也算定义点
  for (const match of source.matchAll(/\s:?style="([^"]*)"/g)) allInlineCss += match[1] + ';\n';
}

const defined = new Set();
for (const match of (allCss + allInlineCss).matchAll(/(--[\w-]+)\s*:/g)) defined.add(match[1]);
// 运行时通过 setProperty / 绑定对象注入的也算定义点
for (const rel of [...sfcFiles, 'src/main.ts']) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) continue;
  const source = fs.readFileSync(abs, 'utf8');
  for (const match of source.matchAll(/setProperty\(\s*['"`](--[\w-]+)/g)) defined.add(match[1]);
  for (const match of source.matchAll(/['"`](--[\w-]+)['"`]\s*:/g)) defined.add(match[1]);
}

const referenced = new Map();
function collectRefs(rawText: string, label: any) {
  // 先剥注释:CSS 注释与 HTML 注释里的 var(--xxx) 是文档示例,不是真实引用
  const text = rawText.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  for (const match of text.matchAll(/var\(\s*(--[\w-]+)\s*([,)])/g)) {
    // 带 fallback 的 var(--x, y) 不算缺陷:显式声明了降级
    if (match[2] === ',') continue;
    if (!referenced.has(match[1])) referenced.set(match[1], label);
  }
}
for (const rel of cssFiles) collectRefs(fs.readFileSync(path.join(root, rel), 'utf8'), rel);
for (const rel of htmlFiles) collectRefs(fs.readFileSync(path.join(root, rel), 'utf8'), rel);
for (const rel of sfcFiles) collectRefs(fs.readFileSync(path.join(root, rel), 'utf8'), rel);

for (const [name, where] of referenced) {
  if (!defined.has(name)) fail(`${where} 引用了未定义的设计 token ${name}(会静默掉样式)`);
}

// ---- 4. 视觉 slop 反模式（Impeccable 41 条规则中与本项目视觉语言相关的两条） ---
// 4a. 渐变字(background-clip:text)白名单:只允许 .hero-title 与 .page-header,
//     防止 AI 把任意标题/按钮都涂成渐变(impeccable 的 gradient-text 反模式)。
// 4b. border-radius 必须走 token:硬编码数字圆角会让视觉系统漂移;允许 50%(圆形)、
//     含 var(--r-*) 的混合值、以及 .nav-links 的 45° 菱形指示点(既有装饰)。

// 取 background-clip:text / border-radius 所在规则块的选择器文本。
// 必须用配对扫描：lastIndexOf('{')/lastIndexOf('}') 在嵌套块(如 @supports)
// 里会配对错乱(找到内层空块的 } 导致切片为空)。
function selectorOf(text: string, index: number) {
  let depth = 0;
  for (let j = index; j >= 0; j -= 1) {
    const c = text[j];
    if (c === '}') depth += 1;
    else if (c === '{') {
      if (depth === 0) {
        const start = text.lastIndexOf('}', j);
        return text.slice(start + 1, j).replace(/\s+/g, ' ').trim();
      }
      depth -= 1;
    }
  }
  return '';
}

for (const rel of cssFiles) {
  const raw = fs.readFileSync(path.join(root, rel), 'utf8');
  // 剥注释后再扫描:注释里的 { } 与 background-clip 示例不算真实规则
  const text = raw.replace(/\/\*[\s\S]*?\*\//g, ' ');
  for (const match of text.matchAll(/background-clip:\s*text\s*;/g)) {
    const selector = selectorOf(text, match.index);
    if (!/\.hero-title|\.page-header|\.title-gradient/.test(selector)) {
      const line = text.slice(0, match.index).split('\n').length;
      fail(`${rel}:${line} 渐变字(background-clip:text)只允许 .hero-title / .page-header / .title-gradient,当前选择器: ${selector.slice(0, 60)}`);
    }
  }
  for (const match of text.matchAll(/border-radius:\s*([^;}]+)/g)) {
    const value = match[1].trim();
    if (/^((50%|0)(\s+(50%|0))*)$/.test(value)) continue;
    if (value.includes('var(')) continue;
    if (/^[a-z-]+$/.test(value)) continue;
    const selector = selectorOf(text, match.index);
    // .nav-brand .dot 是品牌 logo 菱形(非对称圆角是品牌图形本身,有注释声明)
    if (selector.includes('.nav-brand .dot')) continue;
    const line = text.slice(0, match.index).split('\n').length;
    fail(`${rel}:${line} border-radius 必须用 var(--r-*) 或 50%(圆形): "${value}" → ${selector.slice(0, 60)}`);
  }
}

// ---- 报告 ------------------------------------------------------------------
// Template classes and @apply obey the same radius-token rule as declarations.
for (const rel of [...cssFiles, ...htmlFiles, ...sfcFiles, ...sources.utilityScriptFiles()]) {
  for (const utility of sources.tailwindUtilities(fs.readFileSync(path.join(root, rel), 'utf8'))) {
    for (const { property, value } of utility.declarations) {
      if (property !== 'border-radius' || value.includes('var(') || /^(?:(?:50%|0)(?:\s+(?:50%|0))*|inherit|initial|unset|revert)$/.test(value)) continue;
      fail(`${rel}:${utility.line} Tailwind 圆角必须使用设计令牌或 50%（圆形）: ${utility.candidate}`);
    }
  }
}

if (failures.length) {
  console.error('样式债门禁失败:');
  for (const message of failures) console.error('  - ' + message);
  process.exit(1);
}

const carriers = [...htmlFiles, ...sfcFiles].reduce((total, rel) => {
  const source = fs.readFileSync(path.join(root, rel), 'utf8');
  return total + (source.match(/\s:?style="/g) || []).length;
}, 0);
console.log('inline style occurrences: ' + carriers);
});


test('contrast: parses real theme overrides, nested mixes and alpha without silent skips', () => {
  const assert: typeof import('node:assert/strict') = require('node:assert/strict');
  const { block, resolveColor, ratio, themes, characterThemes }: typeof import('../maintenance/check-contrast') = require('../maintenance/check-contrast');
  const css = ':root[data-theme="light"] { --ink: #111; } :root { --ink: #fff; }';
  assert.equal(block(':root', css)['--ink'], '#fff');
  assert.equal(block(':root[data-theme="light"]', '@reference "./tailwind.css";\n' + css)['--ink'], '#111');
  assert.throws(() => block('.missing', css), /Missing CSS token block/);
  assert.deepEqual(themes.map(([name]) => name), ['dark', 'light', 'terraria-dark', 'terraria-light']);
  assert.notEqual((themes[0][1] as Record<string, any>)['--text-primary'], (themes[1][1] as Record<string, any>)['--text-primary']);
  const mix = resolveColor({ '--a': '#ffffff', '--b': '#000000' }, 'color-mix(in srgb, var(--a) 40%, var(--b))');
  assert.deepEqual(mix, [102, 102, 102]);
  assert.equal(ratio([0, 0, 0], [255, 255, 255]), 21);
  assert.deepEqual(resolveColor({}, '#fff0', [10, 20, 30]), [10, 20, 30]);
  assert.deepEqual(resolveColor({}, 'rgba(255,255,255,50%)', [0, 0, 0]), [127.5,127.5,127.5]);
  assert.deepEqual(resolveColor({}, 'var(--missing, #abc)'), [170,187,204]);
  assert.equal(resolveColor({ '--a': 'var(--a)' }, 'var(--a)'), null);
  assert.equal(resolveColor({}, 'unsupported(blue)'), null);
  assert.equal(resolveColor({}, 'rgba(..,0,0,1)'), null);
  assert.equal(resolveColor({}, 'color-mix(in srgb, #fff ..%, #000)'), null);
  assert.ok(characterThemes().some(([name]: any) => name.startsWith('light /')));
});

test('Tailwind source audit sees variants, arbitrary properties and dynamic class maps', () => {
  const assert: typeof import('node:assert/strict') = require('node:assert/strict');
  const source = `<template><div class="tw:[&>span]:hover:text-[#123456] tw:text-[length:14px] tw:z-50"
    :class="{ 'tw:rounded-[12px]': active, 'tw:bg-[var(--bg-surface)]': !active }" /></template>
    <style>.item { @apply tw:[font-size:18px] tw:transition-[width,opacity]; }</style>
    <!-- tw:bg-[#abcdef] --> /* tw:z-[999] */`;
  const utilities = sources.tailwindUtilities(source);
  assert.equal(utilities.length, 7);
  assert.equal(utilities[0].candidate, 'tw:[&>span]:hover:text-[#123456]');
  assert.equal(sources.tailwindColorLiterals(source).length, 1);
  const declarations = utilities.map(sources.utilityCss).join('\n');
  assert.match(declarations, /font-size: 14px/);
  assert.match(declarations, /font-size: 18px/);
  assert.match(declarations, /border-radius: 12px/);
  assert.match(declarations, /z-index: 50/);
  assert.match(declarations, /transition-property: width,opacity/);
});

test('color lint rejects utility hex, function and named literals while accepting theme tokens', () => {
  const assert: typeof import('node:assert/strict') = require('node:assert/strict');
  const { scanFile }: typeof import('../maintenance/lint-colors') = require('../maintenance/lint-colors');
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'huiyu-tailwind-colors-'));
  const file = path.join(directory, 'Example.vue');
  try {
    fs.writeFileSync(file, `<template><div class="tw:bg-[#12345678] tw:text-[red] tw:bg-[rgb(1_2_3)] tw:text-primary tw:bg-[var(--bg-surface)]" /></template>
      <style>.item { @apply tw:border-[color:hsl(20_30%_40%)]; }</style>`);
    assert.equal(scanFile(file).length, 4);
    assert.equal(sources.tailwindColorLiterals('tw:bg-[color-mix(in_srgb,var(--accent)_40%,#123456)]').length, 1);
    assert.equal(sources.tailwindColorLiterals('tw:bg-[transparent] tw:text-[currentColor] tw:text-[var(--ink)]').length, 0);
    assert.equal(sources.tailwindColorLiterals('tw:[border-style:dashed]').length, 0);
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(directory);
  }
});

test('compositor gate catches layout utilities in transitions and keyframes', () => {
  const assert: typeof import('node:assert/strict') = require('node:assert/strict');
  const { scanCss, scanUtilityAnimations }: typeof import('../maintenance/lint-animations') = require('../maintenance/lint-animations');
  const css = '.item { @apply tw:transition-[height,opacity]; } @keyframes grow { to { @apply tw:w-full tw:px-[12px]; } }';
  assert.equal(scanCss('fixture.css', css).filter(f => !f.warnOnly).length, 3);
  assert.equal(scanCss('fixture.css', '@keyframes shift { to { @apply tw:-left-[12px] tw:inset-x-0 tw:size-[40px]; } }').length, 4);
  const unsafe = '<div class="tw:hover:transition-[width] tw:transition-all tw:[transition:inset_200ms]" />';
  assert.equal(scanUtilityAnimations('fixture.vue', unsafe).filter(f => !f.exempt).length, 3);
  assert.equal(scanUtilityAnimations('fixture.vue', '<div class="tw:transition-[transform,opacity]" />').length, 0);
  assert.equal(scanCss('fixture.css', '/* @apply tw:transition-[height]; */').length, 0);
  const exempt = '/* compositor-exempt: bounded disclosure with unknown content height */ <div class="tw:transition-[height]" />';
  assert.equal(scanUtilityAnimations('fixture.vue', exempt)[0].exempt, true);
});
