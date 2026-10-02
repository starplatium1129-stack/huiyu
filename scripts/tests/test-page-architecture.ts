import { sourceImports } from '../lib/source-imports';
'use strict';

const { test }: typeof import('node:test') = require('node:test');

test("page-architecture", () => {
/**
 * Vue SPA 页面架构校验（重构后版本）
 *
 * 只保留构建与组件行为测试无法直接表达的跨页面边界：CSP、路由懒加载、
 * 路由样式隔离及字体网络来源。模块存在与 SFC 语法由 typecheck/build 负责，
 * 局部交互和动效分别由现有行为测试与 lint-animations 负责。
 */

const assert: typeof import('assert') = require('assert');
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const root = path.resolve(__dirname, '..', '..');
const src = path.join(root, 'src');

function read(rel: any) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}
// ── 1. index.html 必须是纯 SPA 入口 ───────────────────────────────────────
const indexHtml = read('index.html');
const scriptTags = [...indexHtml.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)];
const inlineScripts = scriptTags.filter(m => !/\bsrc\s*=/.test(m[1]) && m[2].trim());
assert.strictEqual(
  inlineScripts.length, 0,
  'index.html must not contain inline scripts (Vue SPA entry only)',
);
assert(
  !/<script[^>]+src=["']\/?tools\//i.test(indexHtml),
  'index.html must not load legacy tools/ controllers',
);
assert(
  /<script[^>]+type=["']module["'][^>]+src=["']\/src\/main\.ts["']/.test(indexHtml),
  'index.html must load /src/main.ts as a module',
);

// ── 2. 路由 view 必须懒加载 ─────────────────────────────────────────────
const routerSource = read('src/router/index.ts');
const imports = sourceImports(routerSource);
const views = imports.filter(edge => edge.specifier.startsWith('@/views/') && !edge.typeOnly);
assert(views.length > 0, 'router must expose view imports before checking lazy loading');
assert(views.every(edge => edge.dynamic), 'every route view must be lazy-loaded');

// ── 3. view / component 不得使用内联 HTML 事件属性 ───────────────────────
// Vue 用 @click / v-on 绑定；出现 onclick= 说明是拼接字符串塞进 v-html，会被 CSP 拦。
const inlineHandlerRe = /\son(?:click|change|input|submit|keydown|keyup|focus|blur|error)\s*=\s*["'][^"']/i;

function walk(dir: any): any {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const srcFiles = walk(src);
const vueFiles = srcFiles.filter((f: any) => f.endsWith('.vue'));
assert(vueFiles.length > 0, 'CSP scan must inspect application components');

for (const file of vueFiles) {
  const rel = path.relative(root, file).replace(/\\/g, '/');
  const source = fs.readFileSync(file, 'utf8');
  assert(
    !inlineHandlerRe.test(source),
    `${rel} must not use inline HTML event attributes (use @event bindings)`,
  );
}

const docsNav = read('tools/nav.js');
const docsStatus = read('tools/local-status.js');
assert(
  !/tools\/[a-z-]+\.html/.test(docsNav + docsStatus),
  'docs navigation must link to current SPA routes, not deleted tools/*.html pages',
);
// ── 4. 样式加载分层：跨路由的进全局，路由专属的进各自视图 ────────────────
// director.css(91.6KB) + chat.css(18.6KB) 曾占 139KB 全局包的 79%，
// 却只服务 /prompt-builder 与 /chat。移入视图后由 cssCodeSplit 切成路由块。
const mainTs = read('src/main.ts');
for (const css of ['director.css', 'chat.css', 'scene-card.css', 'mood.css', 'viewer.css']) {
  assert(
    !new RegExp(`assets/css/${css.replace('.', '\\.')}`).test(mainTs),
    `${css} is route-scoped — it must not be imported globally in src/main.ts`,
  );
}
// Component-owned styles must load on every real consuming path, without
// restoring them to the shared entry merely to satisfy a source-string test.
for (const [css, owners] of [
  ['scene-card.css', ['src/components/SceneCard.vue']],
  ['mood.css', ['src/views/ColorScriptView.vue', 'src/views/StyleView.vue', 'src/components/director/DirectorDecisionsRail.vue']],
  ['viewer.css', ['src/views/GalleryView.vue', 'src/views/ShowcaseView.vue']],
] as const) {
  for (const owner of owners) {
    assert(read(owner).includes(`@/assets/css/${css}`), `${owner} must load its ${css} styles`);
  }
}
assert(
  /assets\/css\/director\.css/.test(read('src/views/PromptBuilderView.vue')),
  'PromptBuilderView must import director.css so it ships in the route chunk',
);
assert(
  /assets\/css\/chat\.css/.test(read('src/views/ChatView.vue')),
  'ChatView must import chat.css so it ships in the route chunk',
);
assert(
  /assets\/css\/companion\.css/.test(read('src/views/CompanionView.vue')),
  'CompanionView must import its own route-scoped stylesheet',
);
assert(
  !/assets\/css\/companion\.css/.test(read('src/views/ChatView.vue'))
    && !/(?:import\s+ChatView|<ChatView)/.test(read('src/views/CompanionView.vue')),
  'website chat and companion must remain independent presentation roots',
);

// D-1: director.css 虽然跟随 /prompt-builder 路由块加载，但 Vite 注入过一次后
// CSS 仍会留在 document 里。过去 571 个裸选择器（`.scene-search`、`.panel`、
// `.history-item` 等）会污染随后访问的任意路由。普通选择器必须以 `.pb` 根
// 开始；body:has(.pb…) / @property / keyframes 是刻意保留的全局规则。
// 2026-08-26 修复：director.css 已拆为 director/*.css 四片，聚合后校验。
// 2026-08-27 分产：components/<Owner>.css 按异步组件懒加载，聚合需一并递归。
function readDirectorCss() {
  const entry = read('src/assets/css/director.css');
  const dir = path.join(root, 'src/assets/css/director');
  const parts = [entry];
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir).filter(n => n.endsWith('.css'))) {
      if (name === 'view-shell.css') {
        assert(/<style\s+scoped\s+src="@\/assets\/css\/director\/view-shell\.css"/.test(read('src/views/PromptBuilderView.vue')));
        assert(!entry.includes('view-shell.css'), 'scoped view CSS must not enter the global CSS entry');
        continue;
      }
      parts.push(read(path.join('src/assets/css/director', name)));
    }
    const componentsDir = path.join(dir, 'components');
    if (fs.existsSync(componentsDir)) {
      for (const name of fs.readdirSync(componentsDir).filter(n => n.endsWith('.css'))) {
        parts.push(read(path.join('src/assets/css/director/components', name)));
      }
    }
  }
  return parts.join('\n');
}
// 命名空间泄漏扫描前先剥注释：注释里的 .xxx 示例（如 GenerationQueuePanel.css
// 的定位上下文说明）不是选择器，计入会误报。
const directorCss = readDirectorCss().replace(/\/\*[\s\S]*?\*\//g, '');
const leakedDirectorSelectors = [...directorCss.matchAll(/^\s*\.([A-Za-z_-][\w-]*)/gm)]
  .map(m => m[1])
  .filter(name => name !== 'pb' && !name.startsWith('pb-'));
assert.strictEqual(
  leakedDirectorSelectors.length, 0,
  'director.css selectors must be rooted at .pb; leaked: ' + leakedDirectorSelectors.slice(0, 8).join(', '),
);

// chat.css 有同样的生命周期：路由块卸载后样式仍在 document，不能让 `.message`
// `.chat-list` 等裸类污染作品册或场景页。
const chatCss = read('src/assets/css/chat.css');
const leakedChatSelectors = [...chatCss.matchAll(/^\s*\.([A-Za-z_-][\w-]*)/gm)]
  .map(m => m[1])
  .filter(name => name !== 'chat-page' && !name.startsWith('chat-page-'));
assert.strictEqual(
  leakedChatSelectors.length, 0,
  'chat.css selectors must be rooted at .chat-page; leaked: ' + leakedChatSelectors.slice(0, 8).join(', '),
);

// 字体不得在打包 CSS 里 @import：那会造成 HTML→CSS→CSS→字体 三段串行 RTT
assert(
  !/@import\s+url\(["']?https:\/\/fonts\./.test(read('src/assets/css/design-system.css')),
  'fonts must be preconnected/linked from index.html, not @import-ed inside bundled CSS',
);
// P1-7 后字体声明移入独立异步 chunk：main.ts 只负责不阻塞解析的动态 import，
// 入口 CSS 必须保持无字体声明；自托管不变式落在 fonts chunk 本体上。
assert(
  /import\('\.\/assets\/fonts'\)/.test(read('src/main.ts')),
  'main.ts must lazy-import the assets/fonts chunk (entry CSS must stay font-free)',
);
assert(
  /@fontsource\/(noto-sans-sc|jetbrains-mono)\//.test(read('src/assets/fonts.ts')),
  'fonts chunk must still self-host via @fontsource (no CDN)',
);
assert(
  !/fonts\.gstatic\.com/.test(read('index.html')),
  'index.html must not reference Google Fonts CDN when fonts are self-hosted',
);

});

test('router import parsing permits equivalent helpers but distinguishes eager imports', () => {
  const assert: typeof import('node:assert/strict') = require('node:assert/strict');
  assert.deepEqual(sourceImports('const renamed = () => import( /* comment */ "@/views/Page.vue" )'), [{ specifier: '@/views/Page.vue', dynamic: true, typeOnly: false }]);
  assert.equal(sourceImports('import Renamed from "@/views/Page.vue"')[0].dynamic, false);
  assert.deepEqual(sourceImports('// import("@/views/Fake.vue")'), []);
});
