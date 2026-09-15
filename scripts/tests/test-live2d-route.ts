'use strict';

import { Express } from 'express-serve-static-core';

/**
 * routes/live2d 契约测试（2026-08-28 补：此前仅有源码正则断言，无真实请求）。
 * 覆盖：/api/live2d-status 无依赖可用 → 正确降级为 unavailable + 空角色清单；
 * 提供 stub service 时返回其状态。
 */

var assert: typeof import('assert/strict') = require('assert/strict');
var express: typeof import('express') = require('express');
var createLive2dRouter = (require('../../routes/live2d') as typeof import('../../routes/live2d')).createLive2dRouter;

async function json(response: Response) { return response.json(); }

function listen(app: Express) {
  return new Promise(function (resolve) {
    var server = app.listen(0, '127.0.0.1', function () {
      resolve({ server:server, base:'http://127.0.0.1:' + server.address().port });
    });
  });
}
function close(server: any) {
  return new Promise(function (resolve) { server.close(resolve); });
}

async function run() {
  // 1) 真实 service + 空模型目录 → fail-closed 降级（available:false，角色清单为空）。
  var real = createLive2dRouter({ LIVE2D_ROOT:'/nonexistent/live2d-root' });
  var app = express();
  app.use(real.router);
  var live: any = await listen(app);
  try {
    var empty = await json(await fetch(live.base + '/api/live2d-status'));
    assert.equal(empty.available, false, 'missing model directory degrades to unavailable');
    assert.deepEqual(empty.characters, [], 'no characters available without model files');
    assert.equal(typeof empty.models, 'object');
    assert.equal(empty.models.nene.available, false);
    assert.equal(empty.models.natsume.available, false);
  } finally {
    await close(live.server);
  }

  // 2) stub service 注入 → 原样透传其状态（路由零逻辑，只做转发）。
  var stub = createLive2dRouter({}, { live2d:{
    status:function () { return { available:true, characters:['nene'], models:{} }; },
  } });
  var app2 = express();
  app2.use(stub.router);
  var live2: any = await listen(app2);
  try {
    var withStub = await json(await fetch(live2.base + '/api/live2d-status'));
    assert.equal(withStub.available, true);
    assert.deepEqual(withStub.characters, ['nene']);
  } finally {
    await close(live2.server);
  }

  console.log('test-live2d-route: ok');
}

run().catch(function (error) {
  console.error(error);
  process.exit(1);
});
