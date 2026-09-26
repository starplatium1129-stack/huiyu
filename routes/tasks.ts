import express = require('express');
import envelope = require('../server/http-envelope');
import type { TaskRuntime } from '../server/tasks/runtime';
import type { WorkspaceService } from '../server/workspace/client';
import type { WorkspaceSessionAuthority } from '../server/workspace/auth';
import { WORKSPACE_SESSION_HEADER } from '../server/workspace/auth';
import { WorkspaceError } from '../server/workspace/types';
import type { TaskSubmission } from '../types/tasks';
import { errorCode, errorStatus } from '../scripts/lib/runtime-errors';

/** Mount at /api/tasks/v1, after the host has verified the authoritative workspace. */
export function createTaskRouter(options: { runtime: TaskRuntime; workspace: WorkspaceService; authority: WorkspaceSessionAuthority }) {
  const { runtime, workspace, authority } = options;
  const router = express.Router();
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store'); res.vary('Origin');
    if (typeof req.headers.origin === 'string' && authority.allowsOrigin(req)) res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    if (req.method === 'OPTIONS') {
      if (!authority.allowsOrigin(req)) return res.sendStatus(403);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, ' + WORKSPACE_SESSION_HEADER);
      return res.sendStatus(204);
    }
    const session = authority.authenticate(req, req.method === 'GET' ? 'workspace:read' : 'workspace:write');
    if (!session || session.workspaceId !== workspace.workspaceId || session.runtimeEpoch !== workspace.runtimeEpoch)
      return envelope.fail(res, 401, '任务会话无效或已过期', { code: 'WORKSPACE_AUTH' });
    res.locals.principal = session.principalId; next();
  });
  router.use(express.json({ limit: '256kb' }));
  const handle = (action: (req: express.Request, principal: string) => Promise<unknown>): express.RequestHandler => async (req, res) => {
    try { const result = await action(req, String(res.locals.principal)); if (!res.destroyed) envelope.ok(res, { result, runtimeEpoch: runtime.runtimeEpoch }); }
    catch (error) { if (!res.destroyed) envelope.fail(res, errorStatus(error) || 500, '任务请求未完成', { code: errorCode(error) || 'TASK_FAILED' }); }
  };
  router.get('/', handle((_req, principal) => runtime.list(principal)));
  router.get('/legacy-history', handle((_req, principal) => runtime.legacyHistory(principal)));
  router.post('/', handle((req, principal) => {
    if (!req.body || typeof req.body.requestKey !== 'string' || !req.body.requestKey.length || req.body.requestKey.length > 200
      || !['generation', 'anima', 'creative', 'video', 'batch'].includes(req.body.kind) || !req.body.input || typeof req.body.input !== 'object' || Array.isArray(req.body.input))
      throw new WorkspaceError('TASK_INVALID', 'Task submission is invalid', 400);
    return runtime.submit(principal, req.body as TaskSubmission);
  }));
  router.get('/by-key/:key', handle((req, principal) => runtime.findByRequestKey(principal, String(req.params.key))));
  router.delete('/by-key/:key', handle((req, principal) => runtime.cancel(principal, String(req.params.key))));
  router.get('/:id', handle((req, principal) => runtime.get(principal, String(req.params.id))));
  router.delete('/:id', handle(async (req, principal) => runtime.cancel(principal, (await runtime.get(principal, String(req.params.id))).requestKey)));
  router.post('/:id/reconcile', handle((req, principal) => runtime.reconcile(principal, String(req.params.id))));
  router.post('/:id/resume', handle((req, principal) => runtime.resume(principal, String(req.params.id))));
  router.post('/:id/concat', handle((req, principal) => runtime.action(principal, String(req.params.id), 'concat')));
  router.post('/:id/continue', handle((req, principal) => runtime.action(principal, String(req.params.id), 'continue')));
  router.patch('/:id/delivery', handle((req, principal) => {
    if (!['unseen', 'seen', 'saved', 'discarded'].includes(req.body?.state)) throw new WorkspaceError('TASK_INVALID', 'Invalid delivery state', 400);
    return runtime.delivery(principal, String(req.params.id), req.body.state);
  }));
  router.get('/:id/results/:index', async (req, res) => {
    try {
      const principal = String(res.locals.principal); const task = await runtime.get(principal, String(req.params.id));
      const media = task.resultRefs.find(ref => ref.index === Number(req.params.index));
      if (!media) throw new WorkspaceError('TASK_RESULT_MISSING', 'Result unavailable', 404);
      res.setHeader('Content-Type', media.mime); res.setHeader('Content-Length', String(media.bytes));
      let offset = 0;
      while (offset < media.bytes && !res.destroyed) {
        const block = await workspace.request({ kind: 'readMedia', alias: media.alias, offset }, { principalId: principal, workspaceId: workspace.workspaceId, protocolVersion: 1 });
        offset += block.data.length;
        if (!res.write(Buffer.from(block.data))) await new Promise<void>(resolve => {
          const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
          res.once('drain', done); res.once('close', done);
        });
      }
      res.end();
    } catch (error) { if (res.headersSent) res.destroy(); else envelope.fail(res, error instanceof WorkspaceError ? error.status : 500, '结果读取未完成', { code: 'TASK_RESULT_UNAVAILABLE' }); }
  });
  return router;
}
