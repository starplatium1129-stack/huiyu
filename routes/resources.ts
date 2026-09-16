import { errorCode as runtimeErrorCode } from '../scripts/lib/runtime-errors';
'use strict';

import type { GatewayConfig } from '../server/config-types';
import type { ResourceCancelRequest, ResourceTaskRequest } from '../src/types/resources';

const express: typeof import('express') = require('express');
const security: typeof import('../server/security') = require('../server/security');
const envelope: typeof import('../server/http-envelope') = require('../server/http-envelope');
const typedHandler: typeof import('../server/typed-route').typedHandler = require('../server/typed-route').typedHandler;
const { createResourceManager }: typeof import('../scripts/lib/resource-install-gateway') = require('../scripts/lib/resource-install-gateway');
const { publicError }: typeof import('../scripts/lib/resource-install-config') = require('../scripts/lib/resource-install-config');
const { createResourceStatic }: typeof import('./resources-static') = require('./resources-static');
const { ID }: typeof import('../scripts/lib/resource-install-policy') = require('../scripts/lib/resource-install-policy');

function createResourcesRouter(config: GatewayConfig) {
  const manager = createResourceManager(config);
  const router = express.Router();
  // Reuse the same origin/forwarding/local identity checks as other privileged gateway APIs.
  router.use('/api/resources', security.localOnly, (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!security.hostAllowed(req.headers.host, config.PORT, '')) return envelope.fail(res, 403, '该操作仅限本机使用');
    next();
  }, express.json({ limit: '2kb', strict: true }));
  router.get('/api/resources/status', typedHandler((req, res) => {
    if (Object.keys(req.query).some(key => key !== 'refresh') || (req.query.refresh !== undefined && req.query.refresh !== '1')) {
      return envelope.fail(res, 400, '资源状态参数无效', { code: 'USAGE' });
    }
    res.json(manager.status(req.query.refresh === '1'));
  }));
  router.post('/api/resources/tasks', typedHandler<ResourceTaskRequest>((req, res) => {
    const body = req.body;
    if (!body || Array.isArray(body) || Object.keys(body).some(key => !['action', 'releaseId'].includes(key))
      || !['import', 'download', 'recover', 'rollback'].includes(body.action)
      || Object.keys(req.query).length
      || (['import', 'download'].includes(body.action) ? typeof body.releaseId !== 'string' || !ID.test(body.releaseId) : body.releaseId !== undefined)) {
      return envelope.fail(res, 400, '请选择已配置的资源操作与版本', { code: 'USAGE' });
    }
    try { res.status(202).json({ ok: true, task: manager.start(body.action, body.releaseId, security.isDirectLocalRequest(req)) }); }
    catch (error) {
      const safe = publicError(error);
      envelope.fail(res, runtimeErrorCode(error) === 'BUSY' || runtimeErrorCode(error) === 'PENDING_TRANSACTION' ? 409 : 403, safe.message, { code: safe.code });
    }
  }));
  router.post('/api/resources/tasks/:id/cancel', typedHandler<ResourceCancelRequest>((req, res) => {
    const taskId = String(req.params.id);
    if (!/^[a-f\d-]{36}$/.test(taskId) || (req.body && Object.keys(req.body).length)) {
      return envelope.fail(res, 400, '取消任务参数无效', { code: 'USAGE' });
    }
    try { res.json({ ok: true, task: manager.cancel(taskId, security.isDirectLocalRequest(req)) }); }
    catch (error) { const safe = publicError(error); envelope.fail(res, 409, safe.message, { code: safe.code }); }
  }));
  return { router, staticMiddleware: createResourceStatic(manager), manager, close: () => manager.close() };
}
export = { createResourcesRouter };
