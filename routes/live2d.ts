'use strict';

import type { GatewayConfig } from '../server/config-types';
import path from 'node:path';
const { isDirectLocalRequest }: typeof import('../server/security') = require('../server/security');
import { localLive2dRoot, readLocalCompanions } from '../services/live2d-local';
import { modelFile } from '../services/live2d-manifest';
import { createLive2dImportRouter } from './live2d-import';

let express: typeof import('express') = require('express');
let typedHandler: typeof import('../server/typed-route').typedHandler = require('../server/typed-route').typedHandler;
let createLive2dService = (require('../services/live2d-service') as typeof import('../services/live2d-service')).createLive2dService;
let createLive2dTextureService = (require('../services/live2d-textures') as typeof import('../services/live2d-textures')).createLive2dTextureService;

type Live2dConfig = Partial<Pick<GatewayConfig, 'LIVE2D_ROOT' | 'ROOT_DIR' | 'DESKTOP_PACKAGED' | 'RUNTIME_ROOT'>>;
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

  const localRoot = config.ROOT_DIR ? localLive2dRoot(config.ROOT_DIR, config.DESKTOP_PACKAGED ? config.RUNTIME_ROOT : undefined) : '';
  const locals = () => localRoot ? readLocalCompanions(localRoot) : [];
  router.use(createLive2dImportRouter(localRoot));
  const localTextures = localRoot ? createLive2dTextureService(localRoot, {
    characters: () => locals().map(item => item.character.id),
    manifestName: id => locals().find(item => item.character.id === id)?.manifest || '',
    assetBase: '/api/live2d-local/',
  }) : null;
  router.get('/api/live2d-companions', typedHandler(function (req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.json(isDirectLocalRequest(req) ? locals().map(({ character, avatar, profile }) => ({ character, avatar, profile })) : []);
  }));
  router.get('/api/live2d-local/:character/*file', typedHandler(function (req, res) {
    if (!isDirectLocalRequest(req)) return res.status(404).end();
    try {
      const item = locals().find(item => item.character.id === req.params.character);
      const file = Array.isArray(req.params.file) ? req.params.file.join('/') : String(req.params.file);
      if (!item?.files.includes(file)) return res.status(404).end();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(modelFile(path.join(localRoot, item.character.id), file));
    } catch { res.status(404).end(); }
  }));
  router.get('/api/live2d-status', typedHandler(function (req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const status = service.status();
    if (isDirectLocalRequest(req)) for (const item of locals()) {
      const id = item.character.id;
      status.models[id] = { available: true, modelUrl: item.avatar.modelPath, source: 'local-import', missing: [] };
      status.characters.push(id);
    }
    status.available = status.characters.length > 0;
    res.json(status);
  }));

  let textures: Live2dTextureService | null = config.LIVE2D_ROOT ? createLive2dTextureService(config.LIVE2D_ROOT) : null;
  router.get('/api/live2d-model/:character/:quality', typedHandler(function (req, res) {
    try {
      const selected = ['nene', 'natsume'].includes(String(req.params.character)) ? textures : isDirectLocalRequest(req) ? localTextures : null;
      if (!selected) return res.status(404).end();
      res.setHeader('Cache-Control', 'no-cache');
      res.json(selected.manifest(String(req.params.character), String(req.params.quality)));
    } catch { res.status(404).json({ error:'Live2D model unavailable' }); }
  }));
  router.get('/api/live2d-texture/:character/:quality/:index', typedHandler(async function (req, res) {
    try {
      const character = String(req.params.character);
      const quality = String(req.params.quality);
      const index = String(req.params.index);
      const selected = ['nene', 'natsume'].includes(character) ? textures : isDirectLocalRequest(req) ? localTextures : null;
      if (!selected || !/^\d+\.webp$/.test(index)) return res.status(404).end();
      const image = await selected.texture(character, quality, Number(index.slice(0, -5)));
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('ETag', image.etag);
      if (req.headers['if-none-match'] === image.etag) return res.status(304).end();
      res.type('image/webp').send(image.bytes);
    } catch { res.status(404).json({ error:'Live2D texture unavailable' }); }
  }));

  return { router:router, service:service };
}

export = { createLive2dRouter:createLive2dRouter };
