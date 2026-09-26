import { randomBytes } from 'node:crypto';
import type { Request } from 'express';
import security = require('../security');

export const WORKSPACE_SESSION_HEADER = 'x-aics-workspace-session';
export type WorkspaceScope = 'workspace:read' | 'workspace:write' | 'workspace:backup';

export interface WorkspaceSession {
  workspaceId: string;
  runtimeEpoch: string;
  principalId: string;
  scopes: readonly WorkspaceScope[];
  origin: string;
  expiresAt: number;
}

export interface WorkspaceSessionAuthority {
  issue(input: { principalId: string; scopes: WorkspaceScope[]; origin: string; ttlMs?: number }):
    WorkspaceSession & { token: string };
  authenticate(req: Request, scope: WorkspaceScope): WorkspaceSession | null;
  allowsOrigin(req: Request): boolean;
  close(): void;
}

/** Only a trusted in-process host receives this issuer; there is no HTTP mint endpoint. */
export function createWorkspaceSessionAuthority(options: {
  workspaceId: string;
  runtimeEpoch: string;
  allowedOrigins: readonly string[];
}): WorkspaceSessionAuthority {
  const origins = new Set(options.allowedOrigins);
  for (const origin of origins) {
    const url = new URL(origin);
    const expected = url.protocol === 'tauri:' ? 'tauri://localhost' : url.origin;
    if (origin !== expected || !security.isDirectLocalRequest({
      socket: { remoteAddress: '127.0.0.1' }, headers: { origin },
    })) throw new Error('Workspace origins must be explicit local application origins');
  }
  const sessions = new Map<string, WorkspaceSession>();
  let closed = false;
  function requestOrigin(req: Request): string | null {
    if (Object.prototype.hasOwnProperty.call(req.headers, 'origin')) {
      return typeof req.headers.origin === 'string' && origins.has(req.headers.origin) ? req.headers.origin : null;
    }
    // Same-origin browser GETs omit Origin. Require both browser provenance signals
    // and an exact registered origin/Host match; the private session remains mandatory.
    if (!['GET', 'HEAD'].includes(req.method) || req.headers['sec-fetch-site'] !== 'same-origin'
        || typeof req.headers.referer !== 'string') return null;
    try {
      const referer = new URL(req.headers.referer);
      return ['http:', 'https:'].includes(referer.protocol) && !referer.username && !referer.password
        && referer.host.toLowerCase() === req.headers.host?.toLowerCase() && origins.has(referer.origin)
        ? referer.origin : null;
    } catch { return null; }
  }
  function allowsOrigin(req: Request): boolean {
    return !closed && security.hostAllowed(req.headers.host) && security.isDirectLocalRequest(req)
      && requestOrigin(req) !== null;
  }
  return {
    issue(input) {
      const ttlMs = input.ttlMs ?? 15 * 60 * 1000;
      if (closed || !origins.has(input.origin) || !input.principalId || input.principalId.length > 200
          || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 30 * 60 * 1000
          || !input.scopes.length || input.scopes.some(scope =>
            !['workspace:read', 'workspace:write', 'workspace:backup'].includes(scope))) {
        throw new Error('Invalid workspace session grant');
      }
      for (const [key, session] of sessions) if (session.expiresAt <= Date.now()) sessions.delete(key);
      const token = randomBytes(32).toString('base64url');
      const session: WorkspaceSession = {
        workspaceId: options.workspaceId, runtimeEpoch: options.runtimeEpoch,
        principalId: input.principalId, scopes: [...new Set(input.scopes)],
        origin: input.origin, expiresAt: Date.now() + ttlMs,
      };
      sessions.set(token, session);
      return { ...session, scopes: [...session.scopes], token };
    },
    authenticate(req, scope) {
      if (!allowsOrigin(req)) return null;
      const token = req.headers[WORKSPACE_SESSION_HEADER];
      if (typeof token !== 'string') return null;
      const session = sessions.get(token);
      if (!session) return null;
      if (session.expiresAt <= Date.now()) { sessions.delete(token); return null; }
      if (session.origin !== requestOrigin(req) || !session.scopes.includes(scope)) return null;
      return { ...session, scopes: [...session.scopes] };
    },
    allowsOrigin,
    close() { closed = true; sessions.clear(); },
  };
}
