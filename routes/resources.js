'use strict';

const express = require('express');
const security = require('../server/security');
const envelope = require('../server/http-envelope');
const { createResourceManager } = require('../scripts/lib/resource-install-gateway');
const { publicError } = require('../scripts/lib/resource-install-config');
const { createResourceStatic } = require('./resources-static');
const { ID } = require('../scripts/lib/resource-install-policy');

function createResourcesRouter(config) {
  const manager = createResourceManager(config);
  const router = express.Router();
  // Reuse the same origin/forwarding/local identity checks as other privileged gateway APIs.
  router.use('/api/resources', security.localOnly, (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!security.hostAllowed(req.headers.host, config.PORT, '')) return envelope.fail(res, 403, '该操作仅限本机使用');
    next();
  }, express.json({ limit: '2kb', strict: true }));
  router.get('/api/resources/status', (req, res) => {
    if (Object.keys(req.query).some(key => key !== 'refresh') || (req.query.refresh !== undefined && req.query.refresh !== '1')) {
      return envelope.fail(res, 400, '资源状态参数无效', { code: 'USAGE' });
    }
    res.json(manager.status(req.query.refresh === '1'));
  });
  router.post('/api/resources/tasks', (req, res) => {
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
      envelope.fail(res, error.code === 'BUSY' || error.code === 'PENDING_TRANSACTION' ? 409 : 403, safe.message, { code: safe.code });
    }
  });
  router.post('/api/resources/tasks/:id/cancel', (req, res) => {
    if (!/^[a-f\d-]{36}$/.test(req.params.id) || (req.body && Object.keys(req.body).length)) {
      return envelope.fail(res, 400, '取消任务参数无效', { code: 'USAGE' });
    }
    try { res.json({ ok: true, task: manager.cancel(req.params.id, security.isDirectLocalRequest(req)) }); }
    catch (error) { const safe = publicError(error); envelope.fail(res, 409, safe.message, { code: safe.code }); }
  });
  return { router, staticMiddleware: createResourceStatic(manager), manager, close: () => manager.close() };
}
module.exports = { createResourcesRouter };
