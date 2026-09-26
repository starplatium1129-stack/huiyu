import express = require('express');
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import security = require('../security');
import type { WorkspaceService } from './client';
import type { WorkspaceSessionAuthority, WorkspaceSession } from './auth';

/** A capability grants only GET/HEAD of one immutable original for two minutes.
 * It never carries the broader workspace session in a DOM/media URL. */
export function createWorkspaceMediaRouter(service: WorkspaceService, authority: WorkspaceSessionAuthority) {
  const router = express.Router();
  const grants = new Map<string, { alias: string; session: WorkspaceSession; expiresAt: number }>();
  router.use((req, res, next) => {
    if (!req.path.startsWith('/media-capabilities') && !req.path.startsWith('/media-content/')) return next();
    res.vary('Origin');
    if (typeof req.headers.origin === 'string' && authority.allowsOrigin(req)) res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    if (req.method !== 'OPTIONS') return next();
    if (!authority.allowsOrigin(req)) return res.status(403).end();
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-aics-workspace-session, Range');
    return res.status(204).end();
  });
  router.post('/media-capabilities', express.json({ limit: '8kb' }), async (req, res) => {
    const session = authority.authenticate(req, 'workspace:read');
    if (!session) return res.status(401).json({ error: 'WORKSPACE_AUTH' });
    const alias: unknown = req.body?.alias;
    if (typeof alias !== 'string' || !alias.length || alias.length > 256) return res.status(400).json({ error: 'MEDIA_INVALID' });
    const context = { workspaceId: service.workspaceId, principalId: session.principalId, protocolVersion: 1 as const };
    try {
      await service.request({ kind: 'readMedia', alias, offset: 0, length: 1 }, context);
      for (const [key, grant] of grants) if (grant.expiresAt < Date.now()) grants.delete(key);
      if (grants.size >= 256) return res.status(429).json({ error: 'MEDIA_BUSY' });
      const token = randomBytes(32).toString('base64url');
      const expiresAt = Math.min(Date.now() + 120_000, session.expiresAt);
      grants.set(token, { alias, session, expiresAt });
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ url: `/api/workspace/media-content/${encodeURIComponent(alias)}?cap=${token}`, expiresAt });
    } catch { return res.status(404).json({ error: 'MEDIA_UNAVAILABLE' }); }
  });
  router.route('/media-content/:alias').get(serve).head(serve);
  async function serve(req: express.Request, res: express.Response) {
    const grant = typeof req.query.cap === 'string' ? grants.get(req.query.cap) : undefined;
    let origin: string | undefined;
    try { origin = typeof req.headers.origin === 'string' ? req.headers.origin : new URL(req.headers.referer || '').origin; } catch { /* denied below */ }
    // Browser media GETs under no-referrer omit both headers even in CORS mode.
    // Only this short-lived, single-object capability may use same-origin Fetch
    // Metadata plus an exact grant-origin/Host match. Private JSON remains strict.
    const grantedOrigin = grant ? new URL(grant.session.origin) : null;
    const sameOriginMedia = req.headers.origin === undefined && req.headers.referer === undefined
      && req.headers['sec-fetch-site'] === 'same-origin' && grantedOrigin?.protocol === 'http:'
      && grantedOrigin.host.toLowerCase() === req.headers.host?.toLowerCase();
    const direct = sameOriginMedia ? security.isDirectLocalRequest(req)
      : security.isDirectLocalRequest({ socket: req.socket, method: req.method, headers: { ...req.headers, origin } });
    if (!grant || grant.expiresAt <= Date.now() || grant.alias !== req.params.alias || (!sameOriginMedia && origin !== grant.session.origin)
      || !security.hostAllowed(req.headers.host) || !direct) {
      return res.status(401).end();
    }
    const controller = new AbortController();
    res.once('close', () => controller.abort());
    const context = { workspaceId: service.workspaceId, principalId: grant.session.principalId, protocolVersion: 1 as const };
    try {
      const first = await service.request({ kind: 'readMedia', alias: grant.alias, offset: 0, length: 1 }, context, { signal: controller.signal });
      let start = 0, end = first.totalBytes - 1;
      const range = req.headers.range;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || (!match[1] && !match[2])) { res.setHeader('Content-Range', `bytes */${first.totalBytes}`); return res.status(416).end(); }
        if (!match[1]) start = Math.max(0, first.totalBytes - Number(match[2]));
        else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= first.totalBytes) {
          res.setHeader('Content-Range', `bytes */${first.totalBytes}`); return res.status(416).end();
        }
        res.status(206); res.setHeader('Content-Range', `bytes ${start}-${end}/${first.totalBytes}`);
      }
      res.setHeader('Content-Type', first.mime);
      res.setHeader('Content-Length', String(end - start + 1));
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      if (req.method === 'HEAD') return res.end();
      for (let offset = start; offset <= end;) {
        const block = await service.request({ kind: 'readMedia', alias: grant.alias, offset, length: Math.min(1024 * 1024, end - offset + 1) }, context, { signal: controller.signal });
        offset += block.data.length;
        if (!res.write(Buffer.from(block.data))) await once(res, 'drain', { signal: controller.signal });
      }
      return res.end();
    } catch { if (!res.headersSent) return res.status(503).end(); res.destroy(); }
  }
  return router;
}
