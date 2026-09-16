'use strict';

/**
 * routes/interrogate 契约测试（2026-08-28 补：此前零覆盖；2026-08-29 适配真实引擎）。
 * 覆盖：参数校验（mode/threshold/base64）、启发式兜底闭环、status 探测（含 wd14 引擎状态）。
 * 测试栈 AI_WORKSPACE_ROOT 指向空临时目录 → wd14 不可用，WebUI/Comfy mock 无 interrogate 端点
 * → 必然落 heuristic 分支，恰验证零依赖兜底。
 */

let assert: typeof import('assert/strict') = require('assert/strict');
let gatewayStack: typeof import('./gateway-test-stack') = require('./gateway-test-stack');

let TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='.padEnd(2048, 'A'); // padEnd 合法 base64，>1024B 过体积校验

async function json(response: Response) { return response.json(); }
function post(base: string, body: { mode: string; image?: string; threshold?: number; }) {
  return fetch(base + '/api/interrogate', {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify(body),
  });
}

async function run() {
  let stack = await gatewayStack.start();
  try {
    let base = stack.baseUrl;

    // status 探测：无需任何模型，返回引擎清单（含 wd14 真实引擎）与默认阈值。
    let status = await json(await fetch(base + '/api/interrogate/status'));
    assert.equal(status.local, true);
    assert.deepEqual(status.engines, ['wd14', 'webui', 'comfy', 'heuristic']);
    assert.equal(status.thresholdDefault, 0.35);
    assert.equal(typeof status.maxBytes, 'number');
    // wd14 真实引擎状态：测试栈 workspace 无模型 → available=false（结构契约）。
    assert.equal(status.wd14.available, false);
    assert.equal(typeof status.wd14.reason, 'string');

    // 参数校验：mode 白名单 / threshold 范围 / 图片必须存在。
    let badMode = await post(base, { mode:'translate', image:TINY_PNG });
    assert.equal(badMode.status, 400);
    assert.equal((await json(badMode)).code, 'INVALID_PARAMETER');
    let badThreshold = await post(base, { mode:'tag', threshold:1.5, image:TINY_PNG });
    assert.equal(badThreshold.status, 400);
    let missingImage = await post(base, { mode:'tag' });
    assert.equal(missingImage.status, 400);
    assert.equal((await json(missingImage)).code, 'INVALID_IMAGE');
    let tooSmall = await post(base, { mode:'tag', image:'aGVsbG8=' }); // "hello" ~5B
    assert.equal(tooSmall.status, 400);
    assert.equal((await json(tooSmall)).code, 'INVALID_IMAGE');

    // 启发式兜底闭环：无上游可达时仍返回 tags/scores/caption，且可编辑回填。
    let tagResult = await json(await post(base, { mode:'tag', image:TINY_PNG, threshold:0.35 }));
    assert.equal(tagResult.engine, 'heuristic');
    assert.equal(tagResult.editable, true);
    assert.ok(Array.isArray(tagResult.tags) && tagResult.tags.length > 0, 'heuristic tags must be non-empty');
    assert.ok(tagResult.tags.includes('1girl'), 'heuristic baseline includes identity tag');
    assert.equal(typeof tagResult.caption, 'string');
    assert.equal(typeof tagResult.scores, 'object');
    assert.equal(tagResult.scores['1girl'], 0.98, 'score map carries the raw confidence');

    // threshold 过滤：0.9 只保留高置信 tag。
    let strict = await json(await post(base, { mode:'tag', image:TINY_PNG, threshold:0.9 }));
    assert.ok(strict.tags.length < tagResult.tags.length, 'higher threshold filters more tags');

    // caption 模式：返回 prose 且不随 threshold 变化（启发式固定句）。
    let captionResult = await json(await post(base, { mode:'caption', image:TINY_PNG }));
    assert.equal(captionResult.mode, 'caption');
    assert.ok(captionResult.caption.length > 20, 'caption is a full sentence');

    // dataURL 前缀剥除：带 data:image/png;base64, 前缀同样可解。
    let dataUrl = 'data:image/png;base64,' + TINY_PNG;
    let viaDataUrl = await json(await post(base, { mode:'tag', image:dataUrl }));
    assert.equal(viaDataUrl.engine, 'heuristic');
  } finally {
    await stack.close();
  }
  console.log('test-interrogate-routes: ok');
}

run().catch(function (error) {
  console.error(error);
  process.exit(1);
});
