import express = require('express');
import { createDesktopWorkspaceHost } from './workspace/host';
import { createTaskProviders } from './tasks/providers';
import { createTaskRuntime } from './tasks/runtime';
import { createTaskRouter } from '../routes/tasks';
import type { GatewayConfig } from './config-types';
import security = require('./security');
import { NATIVE_DESKTOP_ORIGINS } from '../services/desktopOrigins';

export type DesktopWorkspaceHost = Awaited<ReturnType<typeof createDesktopWorkspaceHost>>;
const taskClosers = new WeakMap<DesktopWorkspaceHost, () => Promise<void>>();
export async function openDesktopRuntimeHost(config: GatewayConfig, env: NodeJS.ProcessEnv): Promise<DesktopWorkspaceHost | undefined> {
  const secret = env.AICS_DESKTOP_GATEWAY_TOKEN, configRoot = env.AICS_DESKTOP_CONFIG_ROOT, sourceProfileId = env.AICS_DESKTOP_SOURCE_PROFILE_ID;
  if (!secret && !configRoot && !sourceProfileId) return undefined;
  if (!secret || !configRoot || !sourceProfileId) throw new Error('Incomplete desktop host identity');
  const host = await createDesktopWorkspaceHost({ secret, configRoot, sourceProfileId, gatewayOrigin: `http://127.0.0.1:${config.PORT}`,
    beforeClose: () => taskClosers.get(host)?.() ?? Promise.resolve() });
  return host;
}

export function desktopResourceCors(host: DesktopWorkspaceHost): express.RequestHandler {
  const nativeOrigins = new Set(NATIVE_DESKTOP_ORIGINS);
  return (req, res, next) => {
    let origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    if (!origin && ['GET', 'HEAD'].includes(req.method) && req.headers.referer) {
      try { origin = new URL(req.headers.referer).origin; } catch { /* Unrecognized resource origin gets no grant. */ }
    }
    if (!host.pointer?.bundledUi || !nativeOrigins.has(origin)
      || !security.isDirectLocalRequest({ socket: req.socket, method: req.method, headers: { ...req.headers, origin } })) return next();
    res.vary('Origin');
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-aics-workspace-session');
      res.status(204).end(); return;
    }
    next();
  };
}

/** Candidate activation can happen while this gateway is running. Bind exactly
 * once to the active service and recover before admitting any new submission. */
export function createDesktopTasks(host: DesktopWorkspaceHost | undefined, providers: Parameters<typeof createTaskProviders>[0], sourceProfileId: string | undefined) {
  const router = express.Router();
  let runtime: ReturnType<typeof createTaskRuntime> | undefined;
  let taskRouter: ReturnType<typeof createTaskRouter> | undefined;
  let recovery: Promise<void> | undefined;
  const connect = () => {
    if (!host?.pointer?.domains.includes('artwork') || !host.service || !host.authority) return false;
    if (!runtime) {
      runtime = createTaskRuntime({ workspace: host.service, providers: createTaskProviders(providers) });
      taskRouter = createTaskRouter({ runtime, workspace: host.service, authority: host.authority });
      recovery = runtime.recover(`desktop:${sourceProfileId}`).then(() => {});
    }
    return true;
  };
  connect();
  router.use(async (req, res, next) => {
    try {
      if (!connect()) return res.status(503).json({ error: '任务工作区尚未激活', code: 'WORKSPACE_UNAVAILABLE' });
      await recovery;
      return taskRouter!(req, res, next);
    } catch (error) { next(error); }
  });
  const close = async () => { await recovery?.catch(() => {}); await runtime?.close(); };
  if (host) taskClosers.set(host, close);
  return { router, close };
}
