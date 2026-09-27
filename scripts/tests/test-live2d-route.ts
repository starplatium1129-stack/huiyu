'use strict';

import { Express } from 'express-serve-static-core';

/**
 * routes/live2d 契约测试（2026-08-28 补：此前仅有源码正则断言，无真实请求）。
 * 覆盖：/api/live2d-status 无依赖可用 → 正确降级为 unavailable + 空角色清单；
 * 内置模型派生资源本机可读，远程共享身份不能绕过原媒体的发布边界。
 */

let assert: typeof import('assert/strict') = require('assert/strict');
let express: typeof import('express') = require('express');
let createLive2dRouter = (require('../../routes/live2d') as typeof import('../../routes/live2d')).createLive2dRouter;

async function json(response: Response) { return response.json(); }

function listen(app: Express) {
  return new Promise(function (resolve) {
    let server = app.listen(0, '127.0.0.1', function () {
      resolve({ server:server, base:'http://127.0.0.1:' + (server.address!() as import('node:net').AddressInfo).port });
    });
  });
}
function close(server: any) {
  return new Promise(function (resolve) { server.close(resolve); });
}

async function run() {
  // 1) 真实 service + 空模型目录 → fail-closed 降级（available:false，角色清单为空）。
  let real = createLive2dRouter({ LIVE2D_ROOT:'/nonexistent/live2d-root' });
  let app = express();
  app.use(real.router);
  let live: any = await listen(app);
  try {
    let empty = await json(await fetch(live.base + '/api/live2d-status'));
    assert.equal(empty.available, false, 'missing model directory degrades to unavailable');
    assert.deepEqual(empty.characters, [], 'no characters available without model files');
    assert.equal(typeof empty.models, 'object');
    assert.equal(empty.models.nene.available, false);
    assert.equal(empty.models.natsume.available, false);
  } finally {
    await close(live.server);
  }

  // 2) 中性本机贴图：原图被拒绝时，派生 API 也不能向远程发布。
  const fs: typeof import('node:fs') = require('node:fs');
  const path: typeof import('node:path') = require('node:path');
  const sharp: typeof import('sharp').default = require('sharp');
  const stack = await (require('./gateway-test-stack') as typeof import('./gateway-test-stack')).start({
    prepare: async ({ root, config }: { root: string; config: import('../../server/config-types').GatewayConfig }) => {
      config.ROOT_DIR = path.join(root, 'app');
      config.ASSETS_ROOT = path.join(config.ROOT_DIR, 'assets');
      config.LIVE2D_ROOT = path.join(config.ASSETS_ROOT, 'live2d');
      config.CHARACTER_REF_ROOT = '';
      config.CHARACTER_REF_EXPLICIT_ROOT = '';
      config.SCENE_SHOWCASE_DIR = '';
      const directory = path.join(config.LIVE2D_ROOT, 'nene');
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'nene.model3.json'), JSON.stringify({ Version: 3,
        FileReferences: { Moc: 'nene.moc3', Textures: ['texture.png'] } }));
      fs.writeFileSync(path.join(directory, 'nene.moc3'), 'neutral core fixture');
      fs.writeFileSync(path.join(directory, 'texture.png'), await sharp({ create: { width: 8, height: 8,
        channels: 3, background: { r: 140, g: 170, b: 210 } } }).png().toBuffer());
    },
  });
  try {
    const model = '/api/live2d-model/nene/standard';
    const texture = '/api/live2d-texture/nene/standard/0.webp';
    const localModel = await fetch(stack.baseUrl + model);
    assert.equal(localModel.status, 200);
    assert.deepEqual((await localModel.json()).FileReferences.Textures, [texture]);
    const localTexture = await fetch(stack.baseUrl + texture);
    assert.equal(localTexture.status, 200);
    assert.match(localTexture.headers.get('content-type')!, /^image\/webp/);
    assert.ok((await localTexture.arrayBuffer()).byteLength > 0);
    const remote = { 'x-token': stack.config.TOKEN, 'x-forwarded-for': '198.51.100.8' };
    for (const route of ['/assets/live2d-current/nene/texture.png', model, texture]) {
      const denied = await fetch(stack.baseUrl + route, { headers: remote });
      assert.equal(denied.status, 403, route);
      await denied.arrayBuffer();
    }
  } finally {
    await stack.close();
  }

  console.log('test-live2d-route: ok');
}

run().catch(function (error) {
  console.error(error);
  process.exit(1);
});
