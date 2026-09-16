'use strict';

import type { GatewayConfig } from '../server/config-types';

let express: typeof import('express') = require('express');
let typedHandler: typeof import('../server/typed-route').typedHandler = require('../server/typed-route').typedHandler;
let createLive2dService = (require('../services/live2d-service') as typeof import('../services/live2d-service')).createLive2dService;
let createLive2dTextureService = (require('../services/live2d-textures') as typeof import('../services/live2d-textures')).createLive2dTextureService;

type Live2dConfig = Partial<Pick<GatewayConfig, 'LIVE2D_ROOT'>>;
type Live2dService = ReturnType<typeof createLive2dService>;
type Live2dTextureService = ReturnType<typeof createLive2dTextureService>;
interface Live2dRouterDependencies { live2d?: Live2dService }

function createLive2dRouter(config: Live2dConfig, dependencies?: Live2dRouterDependencies) {
  const deps = dependencies || {};
  let router = express.Router();
  let service = deps.live2d || createLive2dService({
    rootDir:config.LIVE2D_ROOT || '',
    characters:['nene', 'natsume']
  });

  router.get('/api/live2d-status', typedHandler(function (_req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.json(service.status());
  }));

  let textures: Live2dTextureService | null = config.LIVE2D_ROOT ? createLive2dTextureService(config.LIVE2D_ROOT) : null;
  router.get('/api/live2d-model/:character/:quality', typedHandler(function (req, res) {
    try {
      if (!textures) return res.status(404).end();
      res.setHeader('Cache-Control', 'no-cache');
      res.json(textures.manifest(String(req.params.character), String(req.params.quality)));
    } catch { res.status(404).json({ error:'Live2D model unavailable' }); }
  }));
  router.get('/api/live2d-texture/:character/:quality/:index', typedHandler(async function (req, res) {
    try {
      const character = String(req.params.character);
      const quality = String(req.params.quality);
      const index = String(req.params.index);
      if (!textures || !/^\d+\.webp$/.test(index)) return res.status(404).end();
      const image = await textures.texture(character, quality, Number(index.slice(0, -5)));
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('ETag', image.etag);
      if (req.headers['if-none-match'] === image.etag) return res.status(304).end();
      res.type('image/webp').send(image.bytes);
    } catch { res.status(404).json({ error:'Live2D texture unavailable' }); }
  }));

  return { router:router, service:service };
}

export = { createLive2dRouter:createLive2dRouter };
