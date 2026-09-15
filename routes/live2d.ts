'use strict';

let express: typeof import('express') = require('express');
let createLive2dService = (require('../services/live2d-service') as typeof import('../services/live2d-service')).createLive2dService;
let createLive2dTextureService = (require('../services/live2d-textures') as typeof import('../services/live2d-textures')).createLive2dTextureService;

function createLive2dRouter(config: any, dependencies?: any) {
  dependencies = dependencies || {};
  let router = express.Router();
  let service = dependencies.live2d || createLive2dService({
    rootDir:config.LIVE2D_ROOT,
    characters:['nene', 'natsume']
  });

  router.get('/api/live2d-status', function (req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.json(service.status());
  });

  let textures = config.LIVE2D_ROOT ? createLive2dTextureService(config.LIVE2D_ROOT) : null;
  router.get('/api/live2d-model/:character/:quality', function (req, res) {
    try {
      if (!textures) return res.status(404).end();
      res.setHeader('Cache-Control', 'no-cache');
      res.json(textures.manifest(req.params.character, req.params.quality));
    } catch { res.status(404).json({ error:'Live2D model unavailable' }); }
  });
  router.get('/api/live2d-texture/:character/:quality/:index', async function (req, res) {
    try {
      if (!textures || !/^\d+\.webp$/.test(req.params.index)) return res.status(404).end();
      const image = await textures.texture(req.params.character, req.params.quality, Number(req.params.index.slice(0, -5)));
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('ETag', image.etag);
      if (req.headers['if-none-match'] === image.etag) return res.status(304).end();
      res.type('image/webp').send(image.bytes);
    } catch { res.status(404).json({ error:'Live2D texture unavailable' }); }
  });

  return { router:router, service:service };
}

export = { createLive2dRouter:createLive2dRouter };
