import express = require('express');
import type { Request, Response } from 'express';
import envelope = require('../server/http-envelope');
import { WORKSPACE_SESSION_HEADER, type WorkspaceSessionAuthority, type WorkspaceSession } from '../server/workspace/auth';
import type { WorkspaceService } from '../server/workspace/client';
import { WorkspaceError, type EntityId, type JsonValue, type WorkspaceBody,
  type WorkspaceCommand, type WorkspaceContext, type WorkspaceResults, type MediaInput } from '../server/workspace/types';

const MAX_CHUNK = 1024 * 1024;
function invalid(message = '工作区请求格式无效'): never { throw new WorkspaceError('INVALID_REQUEST', message, 400); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 256 || value.includes('\0')) return invalid();
  return value;
}
function integer(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) return invalid();
  return value;
}
function entityId(value: unknown): EntityId {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return text(value);
}
function body(value: unknown): WorkspaceBody {
  const parsed = record(value);
  entityId(parsed.id);
  // express.json already decoded the JSON tree; fields not known to R2 must round-trip.
  return parsed as WorkspaceBody;
}
function routeId(req: Request): EntityId {
  const id = text(req.params.id);
  if (req.query.idType === undefined || req.query.idType === 'string') return id;
  if (req.query.idType !== 'number' || id.trim() !== id || !id.length) return invalid();
  const numeric = Number(id);
  if (!Number.isFinite(numeric)) return invalid();
  return numeric;
}
function media(value: unknown): MediaInput {
  const parsed = record(value);
  const sha256 = text(parsed.sha256);
  if (!/^[a-f0-9]{64}$/.test(sha256)) return invalid();
  return { alias: text(parsed.alias), sha256, bytes: integer(parsed.bytes, 1), mime: text(parsed.mime) };
}
function chunk(value: unknown): Uint8Array {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(MAX_CHUNK / 3) * 4) return invalid();
  const data = Buffer.from(value, 'base64');
  if (data.length > MAX_CHUNK || data.toString('base64') !== value) return invalid();
  return data;
}

/** Mounted only with a ready worker and an explicitly supplied host session authority. */
export function createWorkspaceRouter(service: WorkspaceService, authority: WorkspaceSessionAuthority) {
  const router = express.Router();
  const sessions = new WeakMap<Request, WorkspaceSession>();
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.vary('Origin');
    if (typeof req.headers.origin === 'string' && authority.allowsOrigin(req)) res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    if (req.method === 'OPTIONS') {
      if (!authority.allowsOrigin(req)) return envelope.fail(res, 403, '工作区来源未授权', { code: 'WORKSPACE_AUTH' });
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, ' + WORKSPACE_SESSION_HEADER);
      return res.status(204).end();
    }
    const scope = req.path.startsWith('/backups') ? 'workspace:backup'
      : ['GET', 'HEAD'].includes(req.method) ? 'workspace:read' : 'workspace:write';
    const session = authority.authenticate(req, scope);
    if (!session || session.workspaceId !== service.workspaceId || session.runtimeEpoch !== service.runtimeEpoch) {
      return envelope.fail(res, 401, '工作区会话无效或已过期', { code: 'WORKSPACE_AUTH' });
    }
    sessions.set(req, session);
    next();
  });
  router.use(express.json({ limit: '2mb', reviver: (_key: string, value: unknown) => {
    if (typeof value === 'number' && !Number.isFinite(value)) return invalid('工作区 JSON 数值必须有限');
    return value;
  } }));

  function context(req: Request): WorkspaceContext {
    const session = sessions.get(req);
    if (!session) throw new WorkspaceError('WORKSPACE_AUTH', '工作区会话无效', 401);
    if (!['GET', 'HEAD'].includes(req.method)) {
      const input = record(req.body);
      if (input.protocolVersion !== 1) throw new WorkspaceError('PROTOCOL_VERSION', '工作区协议版本不兼容', 409);
      if (input.workspaceId !== session.workspaceId) throw new WorkspaceError('WORKSPACE_IDENTITY', '工作区身份不匹配', 409);
    }
    return { principalId: session.principalId, workspaceId: session.workspaceId, protocolVersion: 1 };
  }
  async function handle(req: Request, res: Response, build: () => WorkspaceCommand) {
    const controller = new AbortController();
    const disconnect = () => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', disconnect);
    res.once('close', disconnect);
    let command: WorkspaceCommand | undefined;
    try {
      const owner = context(req);
      command = build();
      const result = await service.request(command, owner, { signal: controller.signal, timeoutMs: 30000 });
      if (res.destroyed) return;
      if (command.kind === 'readMedia') {
        const block = result as WorkspaceResults['readMedia'];
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('X-Workspace-Media-Mime', block.mime);
        res.setHeader('X-Workspace-Media-Offset', String(block.offset));
        res.setHeader('X-Workspace-Media-Total-Bytes', String(block.totalBytes));
        res.setHeader('X-Workspace-Media-Sha256', block.sha256);
        res.setHeader('Access-Control-Expose-Headers', 'X-Workspace-Media-Mime, X-Workspace-Media-Offset, X-Workspace-Media-Total-Bytes, X-Workspace-Media-Sha256');
        return res.end(Buffer.from(block.data));
      }
      return envelope.ok(res, { result, protocolVersion: 1, workspaceId: service.workspaceId, runtimeEpoch: service.runtimeEpoch });
    } catch (error) {
      if (res.destroyed) return;
      const known = error instanceof WorkspaceError;
      const code = known ? error.code : 'WORKSPACE_FAILED';
      const message = code === 'COMMIT_UNKNOWN' ? '提交结果尚未确认，请使用原操作 ID 查询状态'
        : code === 'REVISION_CONFLICT' ? '记录已更新，请重新读取后再修改' : '工作区请求未完成';
      return envelope.fail(res, known ? error.status : 500, message, {
        code, ...(command && 'operationId' in command ? { operationId: command.operationId } : {}),
      });
    } finally {
      req.removeListener('aborted', disconnect);
      res.removeListener('close', disconnect);
    }
  }
  const operationId = (req: Request) => text(req.params.operationId ?? record(req.body).operationId);
  const revision = (req: Request) => integer(record(req.body).expectedRevision);

  router.get('/status', (req, res) => handle(req, res, () => ({ kind: 'status' })));
  router.get('/artworks', (req, res) => handle(req, res, () => ({
    kind: 'listArtworks', ...(req.query.limit !== undefined ? { limit: integer(Number(req.query.limit), 1) } : {}),
    ...(req.query.cursor !== undefined ? { cursor: text(req.query.cursor) } : {}),
    ...(req.query.includeDeleted !== undefined ? { includeDeleted: req.query.includeDeleted === 'true' } : {}),
  })));
  router.get('/artworks/:id', (req, res) => handle(req, res, () => ({ kind: 'getArtwork', id: routeId(req) })));
  router.get('/projects', (req, res) => handle(req, res, () => ({ kind: 'listProjects' })));
  router.get('/operations/:operationId', (req, res) => handle(req, res,
    () => ({ kind: 'getOperation', operationId: operationId(req) })));
  router.post('/artwork-saves/:operationId', (req, res) => handle(req, res, () => ({
    kind: 'prepareSave', operationId: operationId(req), artwork: body(record(req.body).artwork), media: media(record(req.body).media),
  })));
  router.put('/artwork-saves/:operationId/chunks', (req, res) => handle(req, res, () => ({
    kind: 'uploadChunk', operationId: operationId(req), offset: integer(record(req.body).offset), data: chunk(record(req.body).data),
  })));
  router.post('/artwork-saves/:operationId/commit', (req, res) => handle(req, res,
    () => ({ kind: 'commitSave', operationId: operationId(req) })));
  router.post('/artwork-saves/:operationId/abort', (req, res) => handle(req, res,
    () => ({ kind: 'abortSave', operationId: operationId(req) })));
  router.patch('/artworks/:id', (req, res) => handle(req, res, () => ({
    kind: 'patchArtwork', operationId: operationId(req), id: routeId(req), expectedRevision: revision(req),
    patch: record(record(req.body).patch) as Record<string, JsonValue>,
  })));
  router.delete('/artworks/:id', (req, res) => handle(req, res, () => ({
    kind: 'softDeleteArtwork', operationId: operationId(req), id: routeId(req), expectedRevision: revision(req),
  })));
  router.post('/artworks/:id/restore', (req, res) => handle(req, res, () => ({
    kind: 'restoreArtwork', operationId: operationId(req), id: routeId(req), expectedRevision: revision(req),
  })));
  router.post('/projects', (req, res) => handle(req, res, () => {
    const input = record(req.body);
    if (!Array.isArray(input.artworkIds)) return invalid();
    return { kind: 'saveProject', operationId: operationId(req), project: body(input.project),
      artworkIds: input.artworkIds.map(entityId), expectedRevision: input.expectedRevision === null ? null : revision(req) };
  }));
  router.post('/trash/purge', (req, res) => handle(req, res,
    () => ({ kind: 'purgeExpiredTrash', operationId: operationId(req) })));
  router.post('/media/collect', (req, res) => handle(req, res,
    () => ({ kind: 'collectGarbage', operationId: operationId(req) })));
  // Explicit block endpoint: callers assemble bytes; full media Range/capability transport belongs to R8.
  router.get('/media/:alias/chunks', (req, res) => handle(req, res, () => ({
    kind: 'readMedia', alias: text(req.params.alias), offset: req.query.offset === undefined ? 0 : integer(Number(req.query.offset)),
    length: req.query.length === undefined ? MAX_CHUNK : Math.min(MAX_CHUNK, integer(Number(req.query.length), 1)),
  })));
  router.post('/backups', (req, res) => handle(req, res, () => ({ kind: 'backup', operationId: operationId(req) })));
  router.post('/backups/:backupId/restore', (req, res) => handle(req, res,
    () => ({ kind: 'restoreBackup', operationId: operationId(req), backupId: text(req.params.backupId) })));
  router.use((_req, res) => envelope.fail(res, 404, '工作区接口不存在', { code: 'WORKSPACE_ROUTE' }));
  return router;
}
