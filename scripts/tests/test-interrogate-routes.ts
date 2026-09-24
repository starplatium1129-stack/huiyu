'use strict';

/**
 * routes/interrogate 契约测试（2026-08-28 补：此前零覆盖；2026-08-29 适配真实引擎）。
 * 覆盖：参数校验（mode/threshold/base64）、启发式兜底闭环、status 探测（含 wd14 引擎状态）。
 * WD14 显式替身，防止项目 runtime 或环境变量发现真实模型；上游仅用本地 HTTP 夹具。
 */

import fs = require('fs');
import path = require('path');
import http = require('http');
import type { AddressInfo } from 'net';
import wd14 = require('../../server/interrogate-engine');

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
    // wd14 真实引擎状态：有模型时返回 model，无模型时返回 reason（结构契约）。
    assert.equal(typeof status.wd14.available, 'boolean');
    assert.ok(status.wd14.available ? typeof status.wd14.model === 'string' : typeof status.wd14.reason === 'string');
    // 图片反推会触发本机模型与临时文件写入，隧道/代理请求不得借用本机权限。
    let tunneledStatus = await fetch(base + '/api/interrogate/status', { headers:{ 'x-forwarded-for':'203.0.113.10' } });
    assert.ok([401, 403].includes(tunneledStatus.status), 'tunneled interrogate status must be denied');

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

    // 反推闭环：有真实模型走 wd14，无模型走 heuristic 兜底，均返回 tags/scores/caption 且可编辑回填。
    let tagResult = await json(await post(base, { mode:'tag', image:TINY_PNG, threshold:0.35 }));
    assert.ok(tagResult.engine === 'wd14' || tagResult.engine === 'heuristic');
    assert.equal(tagResult.editable, true);
    assert.ok(Array.isArray(tagResult.tags), 'tags must be array');
    assert.equal(typeof tagResult.caption, 'string');
    assert.equal(typeof tagResult.scores, 'object');

    // threshold 过滤：0.9 只保留高置信 tag。
    let strict = await json(await post(base, { mode:'tag', image:TINY_PNG, threshold:0.9 }));
    assert.ok(strict.tags.length <= tagResult.tags.length, 'higher threshold filters more tags');

    // caption 模式：返回 prose。
    let captionResult = await json(await post(base, { mode:'caption', image:TINY_PNG }));
    assert.equal(captionResult.mode, 'caption');
    assert.ok(captionResult.caption.length > 0, 'caption must be non-empty');

    // dataURL 前缀剥除：带 data:image/png;base64, 前缀同样可解。
    let dataUrl = 'data:image/png;base64,' + TINY_PNG;
    let viaDataUrl = await json(await post(base, { mode:'tag', image:dataUrl }));
    assert.ok(viaDataUrl.engine === 'wd14' || viaDataUrl.engine === 'heuristic');
  } finally {
    await stack.close();
  }
  // Isolated WD14 HTTP fixture: verifies async upload and write-failure fallback.
  let calls = 0;
  const comfy = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/object_info') return res.end(JSON.stringify({ WD14Tagger: {} }));
    if (req.url?.startsWith('/pysssss/wd14tagger/tag')) {
      calls += 1;
      return res.end(JSON.stringify('1girl, blue_hair'));
    }
    res.end('{}');
  });
  await new Promise<void>(resolve => comfy.listen(0, '127.0.0.1', resolve));
  const fixture = await gatewayStack.start({ configureConfig(config: { COMFY_HOST: string }) {
    config.COMFY_HOST = 'http://127.0.0.1:' + (comfy.address() as AddressInfo).port;
  } });
  const originalWrite = fs.promises.writeFile;
  try {
    const result = await json(await post(fixture.baseUrl, { mode:'tag', image:TINY_PNG }));
    assert.equal(result.engine, 'comfy');
    assert.equal(calls, 1);
    const inputRoot = path.join(fixture.config.AI_WORKSPACE_ROOT, 'ComfyUI', 'input');
    assert.ok(fs.readdirSync(inputRoot).some(name => name.startsWith('aics_interrogate_')));
    fs.promises.writeFile = async function (target, data, options) {
      if (String(target).includes('aics_interrogate_')) throw new Error('fixture disk full');
      return originalWrite(target, data, options);
    };
    const fallback = await json(await post(fixture.baseUrl, { mode:'tag', image:TINY_PNG }));
    assert.equal(fallback.engine, 'heuristic');
    assert.equal(calls, 1, 'failed writes must not submit nonexistent images upstream');
  } finally {
    fs.promises.writeFile = originalWrite;
    await fixture.close();
    await gatewayStack.closeServer(comfy);
  }
  console.log('test-interrogate-routes: ok');
}

const originalInterrogate = wd14.interrogateTag;
const originalProbe = wd14.probe;
wd14.interrogateTag = async () => ({ ok:false, reason:'fixture disables real inference' });
wd14.probe = () => ({ available:false, reason:'fixture disables real models' });
run().finally(() => {
  wd14.interrogateTag = originalInterrogate;
  wd14.probe = originalProbe;
}).catch(function (error) {
  console.error(error);
  process.exit(1);
});
