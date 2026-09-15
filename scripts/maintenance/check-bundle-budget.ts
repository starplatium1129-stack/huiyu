'use strict';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const DEFAULT_BUDGETS = Object.freeze({
  // PromptBuilder carries the three server-backed engines and their history
  // controls. Heavy expert controls (including artist tags) stay async. Its route
  // chunk is about 136 KiB; the unified /api/generation client module
  // (src/api/generationApi.ts, roadmap "统一前端 API 层") rides in this chunk
  // through useSDGenerate. 2026-08-15「出视频」跨页联动只在此保留薄调用壳
  // （桥接逻辑已拆独立 chunk useVideoBridge，动态 import）；2026-08-16
  // 「加入分镜/去分镜短片」多图批量桥接再 +1 KiB（145 → 146）。
  // 2026-08-16 瘦身：tagMeaning 释义字典（~21 KiB 纯数据，仅 tooltip 用，
  // 改为首次调用动态 import）与 videoPromptProse（出视频/分镜点击时才拉）
  // 移出主块，路由块 148.9 → 124.8 KiB，预算随之 146 → 132 锁住收益；
  // 2026-08-20 新增 Anima 局部换装 (AI Inpaint) 扩展交互，预算调整至 140 KiB。
  routeJavaScript: 140 * 1024,
  routeCss: 115 * 1024,
  // 入口 CSS 预算（2026-08-28 审计 P1-7）：此前入口 CSS 从未被预算约束，
  // 字体声明一路涨到 453KB（315 条 @font-face）才被发现——"门禁管到哪、
  // 债就长到哪"的实例。字体声明已移入异步 fonts chunk（入口 76.9KB），
  // 此预算防 @font-face / 大样式块经 main.ts 重新混入入口。
  entryCss: 100 * 1024,
  // wl-live2d 懒加载块：pixi.js + pixi-live2d-display + cubism4 core 全内联，
  // 大小由依赖决定，这里监控防止未来升级/引入新依赖把它撑得更大。
  lazyChunk: 1000 * 1024,
  // 入口静态依赖闭包（2026-09-06 审计 P2-03）：路由预算只看路由自身 chunk，
  // 而 main.ts 同步 import 的公共模块（prompt/live2d 命名块、vendor 等）才是
  // 每个页面的真实首屏负担。以 2026-09-06 manifest 实测 342.6 KiB 为基线，
  // 预算 390 KiB（告警线 351 KiB ≈ 当前 +8 KiB）。
  entryClosureJavaScript: 390 * 1024,
  // 最大路由静态闭包（2026-09-06 审计 P2-03）：防「路由自身变小、代码搬进
  // 同步共享块」的造假 —— 路由闭包含入口链与全部静态共享模块，去重后统计。
  // 以实测最大的 PromptBuilderView 515.3 KiB 为基线，预算 580 KiB。
  routeClosureJavaScript: 580 * 1024,
});

function routeEntries(manifest: any) {
  return Object.entries(manifest)
    .map(([key, entry]: any) => ({ key, ...entry }))
    .filter((entry: any) => entry.isDynamicEntry === true && (
      /^src\/views\/.+\.vue$/.test(entry.src || entry.key)
      || (!entry.src && /View$/.test(entry.name || ''))
    ));
}

function lazyChunks(manifest: any) {
  return Object.entries(manifest)
    .map(([key, entry]: any) => ({ key, ...entry }))
    .filter((entry: any) => entry.isDynamicEntry === true && !/^src\/views\/.+\.vue$/.test(entry.src || entry.key));
}

function entryEntry(manifest: any) {
  return Object.entries(manifest)
    .map(([key, entry]: any) => ({ key, ...entry }))
    .find((entry: any) => entry.isEntry === true) || null;
}

// 静态 import 闭包（不含 dynamicImports）：从起点沿 imports BFS 收集全部
// manifest key。闭包大小只统计 .js 产物（CSS 已有独立预算），去重后求和。
function staticClosureKeys(manifest: any, startKey: any) {
  const seen = new Set([startKey]);
  const queue = [startKey];
  while (queue.length) {
    const entry = manifest[queue.shift()];
    if (!entry) continue;
    for (const dep of entry.imports || []) {
      if (!seen.has(dep)) {
        seen.add(dep);
        queue.push(dep);
      }
    }
  }
  return [...seen];
}

function staticClosureSize(manifest: any, startKey: any, sizeOf: any) {
  return staticClosureKeys(manifest, startKey).reduce((total: any, key: any) => {
    const file = manifest[key] && manifest[key].file;
    return file && /\.js$/.test(file) ? total + sizeOf(file) : total;
  }, 0);
}

function evaluateManifest(manifest: any, sizeOf: any, budgets: any = DEFAULT_BUDGETS) {
  const routes = routeEntries(manifest).map((entry: any) => {
    const cssFiles = [...new Set(entry.css || [])];
    return {
      route: entry.name || path.basename(entry.src || entry.key, '.vue'),
      file: entry.file,
      javascript: sizeOf(entry.file),
      css: cssFiles.reduce((total: any, file: any) => total + sizeOf(file), 0),
      // 2026-09-06 审计 P2-03：路由自身 chunk + 全部静态共享依赖（去重）。
      // 路由 javascript 变小而闭包变大 = 代码被搬进同步共享块，同样算回涨。
      closureJavaScript: staticClosureSize(manifest, entry.key, sizeOf),
    };
  });

  const warnings: any[] = [];
  const violations: any[] = [];
  for (const route of routes) {
    if (route.javascript > budgets.routeJavaScript) {
      violations.push(`${route.route} JavaScript ${route.javascript} > ${budgets.routeJavaScript}`);
    } else if (route.javascript > budgets.routeJavaScript * 0.9) {
      warnings.push(`${route.route} JavaScript ${kib(route.javascript)} > 90% of ${kib(budgets.routeJavaScript)}`);
    }
    if (route.css > budgets.routeCss) {
      violations.push(`${route.route} CSS ${route.css} > ${budgets.routeCss}`);
    } else if (route.css > budgets.routeCss * 0.9) {
      warnings.push(`${route.route} CSS ${kib(route.css)} > 90% of ${kib(budgets.routeCss)}`);
    }
    if (route.closureJavaScript > budgets.routeClosureJavaScript) {
      violations.push(`${route.route} static closure JavaScript ${route.closureJavaScript} > ${budgets.routeClosureJavaScript}`);
    } else if (route.closureJavaScript > budgets.routeClosureJavaScript * 0.9) {
      warnings.push(`${route.route} static closure JavaScript ${kib(route.closureJavaScript)} > 90% of ${kib(budgets.routeClosureJavaScript)}`);
    }
  }
  return { routes, violations, warnings };
}

function kib(bytes: any) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function run(distDir: any = path.resolve(__dirname, '../../dist')) {
  const manifestPath = path.join(distDir, '.vite', 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Vite manifest missing: ${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const sizeOf = (file: any) => fs.statSync(path.join(distDir, file)).size;
  const result = evaluateManifest(manifest, sizeOf);
  if (result.routes.length < 12) {
    throw new Error(`Expected at least 12 lazy route chunks, found ${result.routes.length}`);
  }
  if (result.violations.length) {
    throw new Error(`Route bundle budget exceeded:\n${result.violations.join('\n')}`);
  }

  // 非路由动态块（wl-live2d 等）只监控大小上限，不设路由级预算
  const lazy = lazyChunks(manifest).map((entry: any) => ({
    key: entry.key,
    file: entry.file,
    javascript: fs.statSync(path.join(distDir, entry.file)).size,
  }));
  // 2026-08-27 审计：懒块此前只有硬上限，90% 告警只覆盖路由预算，
  // wl-live2d 实测 92.3% 时静默逼近悬崖 —— 口径对齐路由块的告警线。
  const lazyWarnings = lazy
    .filter((entry: any) => entry.javascript > DEFAULT_BUDGETS.lazyChunk * 0.9)
    .map((entry: any) => `${path.basename(entry.key)} lazy JavaScript ${kib(entry.javascript)} > 90% of ${kib(DEFAULT_BUDGETS.lazyChunk)}`);
  const lazyViolations = lazy
    .filter((entry: any) => entry.javascript > DEFAULT_BUDGETS.lazyChunk)
    .map((entry: any) => `${entry.key} JavaScript ${entry.javascript} > ${DEFAULT_BUDGETS.lazyChunk}`);
  if (lazyViolations.length) {
    throw new Error(`Lazy chunk budget exceeded:\n${lazyViolations.join('\n')}`);
  }

  const entry = entryEntry(manifest);
  const entryCssBytes = entry ? (entry.css || []).reduce((total: any, file: any) => total + sizeOf(file), 0) : 0;
  if (entryCssBytes > DEFAULT_BUDGETS.entryCss) {
    throw new Error(`Entry CSS budget exceeded: ${(entry.css || []).join(', ')} = ${entryCssBytes} > ${DEFAULT_BUDGETS.entryCss}`
      + '\n字体声明走 src/assets/fonts.ts 异步 chunk，勿在 main.ts 同步 import @fontsource 或大样式。');
  }

  // 2026-09-06 审计 P2-03：入口静态闭包 = 每个页面的真实首屏 JS 负担。
  if (entry) {
    const entryClosure = staticClosureSize(manifest, entry.key, sizeOf);
    if (entryClosure > DEFAULT_BUDGETS.entryClosureJavaScript) {
      throw new Error(`Entry static closure budget exceeded: ${entryClosure} > ${DEFAULT_BUDGETS.entryClosureJavaScript}`
        + '\nmain.ts 链上新挂的同步 import 会进入每个页面：重模块改为首次调用动态 import（参照 tagMeaning / videoPromptProse）。');
    }
    result.entryClosureJavaScript = entryClosure;
  }

  const largestJs = [...result.routes].sort((a: any, b: any) => b.javascript - a.javascript)[0];
  const largestCss = [...result.routes].sort((a: any, b: any) => b.css - a.css)[0];
  const largestLazy = lazy.sort((a: any, b: any) => b.javascript - a.javascript)[0];
  const largestClosure = [...result.routes].sort((a: any, b: any) => b.closureJavaScript - a.closureJavaScript)[0];
  console.log(
    `Route bundle budget passed: ${result.routes.length} routes; `
    + `largest JS ${largestJs.route} ${kib(largestJs.javascript)} / ${kib(DEFAULT_BUDGETS.routeJavaScript)}; `
    + `largest CSS ${largestCss.route} ${kib(largestCss.css)} / ${kib(DEFAULT_BUDGETS.routeCss)}; `
    + `largest lazy ${path.basename(largestLazy.key)} ${kib(largestLazy.javascript)} / ${kib(DEFAULT_BUDGETS.lazyChunk)}; `
    + `entry closure JS ${kib(result.entryClosureJavaScript ?? 0)} / ${kib(DEFAULT_BUDGETS.entryClosureJavaScript)}; `
    + `largest route closure ${largestClosure.route} ${kib(largestClosure.closureJavaScript)} / ${kib(DEFAULT_BUDGETS.routeClosureJavaScript)}; `
    + `entry CSS ${kib(entryCssBytes)} / ${kib(DEFAULT_BUDGETS.entryCss)}`,
  );
  if (result.warnings && result.warnings.length) {
    console.warn(`[warn] bundle budget >90% warning:\n${[...result.warnings, ...lazyWarnings].join('\n')}`);
  } else if (lazyWarnings.length) {
    console.warn(`[warn] bundle budget >90% warning:\n${lazyWarnings.join('\n')}`);
  }
  return result;
}

if (require.main === module) {
  try {
    run(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

export = { DEFAULT_BUDGETS, evaluateManifest, routeEntries, lazyChunks, staticClosureKeys, staticClosureSize, run };
