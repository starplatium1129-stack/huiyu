'use strict';

const assert: typeof import('assert') = require('assert');
const { test }: typeof import('node:test') = require('node:test');
const { readPageMappings, pageBundleReport }: typeof import('../lib/page-bundle-report') = require('../lib/page-bundle-report');

test('page unions derive lazy ancestor and standalone mappings from the router', () => {
  const mappings = readPageMappings(`createRouter({ routes: [
    {path:'/',component:()=>import('@/components/AppLayout.vue'), children:[
      {path:'',component:()=>import('@/views/HomeView.vue')},
      {path:'gallery',component:()=>import('@/views/GalleryView.vue')}]},
    {path:'/control',component:()=>import('@/views/ControlView.vue')}
  ]})`);
  const manifest = {
    main: { file:'main.js', isEntry:true, imports:['entryOnly', 'shared'] },
    entryOnly: { file:'entry-only.js' }, shared: { file:'shared.js' },
    'src/components/AppLayout.vue': { file:'layout.js', imports:['shared'] },
    'src/views/HomeView.vue': { file:'home.js', imports:['shared'] },
    gallery: { name:'GalleryView', file:'gallery.js', imports:['alias'] },
    alias: { file:'shared.js' },
    'src/views/ControlView.vue': { file:'control.js', imports:['shared'] },
  };
  const pages = pageBundleReport(manifest, mappings, () => 100);
  assert.deepEqual(pages[0].javascriptFiles, ['entry-only.js','home.js','layout.js','main.js','shared.js']);
  assert.equal(pages[0].pageJavaScript, 500);
  assert.equal(pages[1].pageJavaScript, 500, 'same emitted file is counted once even under different manifest keys');
  assert.equal(pages[2].pageJavaScript, 400, 'standalone routes exclude AppLayout');
  assert.ok(pages.every(page => page.status === 'measured'));
});

test('page union exposes independent entry bytes without imposing a new budget', () => {
  const manifest = { main:{file:'main.js', isEntry:true}, leaf:{file:'leaf.js', src:'src/views/HomeView.vue', imports:['shared']}, shared:{file:'shared.js'} };
  const page = pageBundleReport(manifest, [{route:'/', sources:['src/views/HomeView.vue'],unknown:[]}], file =>
    ({'main.js':380,'leaf.js':100,'shared.js':200}[file] || 0) * 1024)[0];
  assert.equal(page.pageJavaScript, 680 * 1024);
  assert.equal(page.status, 'measured');
});

test('missing, ambiguous, and unsupported mappings report unknown rather than zero', () => {
  const mapping = [{route:'/', sources:['src/views/HomeView.vue'], unknown:[]}];
  const manifests: Array<Parameters<typeof pageBundleReport>[0]> = [ {}, {main:{file:'main.js',isEntry:true}},
    {main:{file:'main.js',isEntry:true}, a:{file:'a.js',name:'HomeView'}, b:{file:'b.js',name:'HomeView'}},
    {main:{file:'main.js',isEntry:true}, 'src/views/HomeView.vue':{file:'home.js',imports:['missing']}} ];
  for (const manifest of manifests) {
    const report = pageBundleReport(manifest, mapping, () => 1)[0];
    assert.equal(report.status, 'unknown'); assert.equal(report.pageJavaScript, null); assert.ok(report.unknown.length);
  }
  assert.ok(readPageMappings('createRouter({routes: otherRoutes})')[0].unknown.length);
  assert.ok(readPageMappings(`createRouter({routes:[{path:'/',component:loadView}]})`)[0].unknown.length);
});

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
