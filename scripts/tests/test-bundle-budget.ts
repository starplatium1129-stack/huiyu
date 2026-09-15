'use strict';

const assert: typeof import('assert') = require('assert');
const { test }: typeof import('node:test') = require('node:test');

test("Bundle budget tests passed: lazy route discovery, CSS aggregation, and limit failures", () => {
const {
  DEFAULT_BUDGETS,
  evaluateManifest,
  routeEntries,
}: typeof import('../maintenance/check-bundle-budget.js') = require('../maintenance/check-bundle-budget.js');

const manifest = {
  'src/main.ts': {
    file: '_app/index.js',
    isEntry: true,
    src: 'src/main.ts',
  },
  'src/views/HomeView.vue': {
    file: '_app/HomeView.js',
    css: ['_app/HomeView.css'],
    isDynamicEntry: true,
    src: 'src/views/HomeView.vue',
  },
  'src/views/ChatView.vue': {
    file: '_app/ChatView.js',
    css: ['_app/shared.css', '_app/ChatView.css'],
    isDynamicEntry: true,
    src: 'src/views/ChatView.vue',
    imports: ['src/shared/heavy.ts'],
  },
  'src/shared/heavy.ts': {
    file: '_app/heavy.js',
  },
  '_PromptBuilderView.js': {
    file: '_app/PromptBuilderView.js',
    name: 'PromptBuilderView',
    css: ['_app/PromptBuilderView.css'],
    isDynamicEntry: true,
  },
};
const sizes = new Map([
  ['_app/index.js', 100 * 1024],
  ['_app/HomeView.js', 40 * 1024],
  ['_app/HomeView.css', 20 * 1024],
  ['_app/ChatView.js', 80 * 1024],
  ['_app/shared.css', 4 * 1024],
  ['_app/ChatView.css', 30 * 1024],
  ['_app/PromptBuilderView.js', 120 * 1024],
  ['_app/PromptBuilderView.css', 50 * 1024],
  ['_app/heavy.js', 300 * 1024],
]);

assert.strictEqual(routeEntries(manifest).length, 3, 'named facade-free view chunks must still belong to route budgets');
const passing = evaluateManifest(manifest, (file: any) => sizes.get(file));
assert.deepStrictEqual(passing.violations, []);
assert.strictEqual(passing.routes.find!(route => route.route === 'ChatView').css, 34 * 1024);
assert.strictEqual(passing.routes.find!(route => route.route === 'PromptBuilderView').javascript, 120 * 1024);

// 2026-09-06 审计 P2-03：静态闭包 = 自身 + 静态 imports 去重求和；无 imports 的
// 路由闭包等于自身，命名块（无 src）与 src 路由走同一套口径。
const chatView: any = passing.routes.find(route => route.route === 'ChatView');
assert.strictEqual(chatView.closureJavaScript, (80 + 300) * 1024, 'closure must include statically imported shared chunks');
assert.strictEqual(passing.routes.find!(route => route.route === 'HomeView').closureJavaScript, 40 * 1024);

const failing = evaluateManifest(
  manifest,
  (file: any) => file === '_app/HomeView.js' ? DEFAULT_BUDGETS.routeJavaScript + 1 : sizes.get(file),
);
assert(failing.violations.some(message => message.includes('HomeView JavaScript')));

// 「路由变小、代码搬进同步共享块」的造假必须被闭包预算抓住：路由自身 80 KiB
// 远低于 routeJavaScript，但共享块撑大后闭包越线。
const smuggled = evaluateManifest(manifest, (file: any) => file === '_app/heavy.js' ? DEFAULT_BUDGETS.routeClosureJavaScript : sizes.get(file));
assert(smuggled.violations.some(message => message.includes('ChatView static closure')),
  'moving route code into a synchronously shared chunk must trip the closure budget');

});
