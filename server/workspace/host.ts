import express = require('express');
import { randomUUID } from 'node:crypto';
import { openWorkspace, type WorkspaceService } from './client';
import { createWorkspaceGateway, type WorkspaceGateway } from './gateway';
import { createDesktopHostVerifier } from './host-auth';
import { readWorkspacePointer, writeWorkspacePointer, workspaceRoot, type WorkspacePointer } from './activation';
import { WorkspaceError, type WorkspaceContext } from './types';
import { createWorkspaceMediaRouter } from './host-media';

export interface DesktopWorkspaceHostOptions {
  configRoot: string;
  secret: string;
  gatewayOrigin: string;
  /** Host-supplied stable profile identity; never derived from the HTTP port. */
  sourceProfileId: string;
  beforeClose?: () => Promise<void>;
}

/** The only production composition root for a private workspace. No pointer means
 * migration has not been started; starting the ordinary app does not create a DB. */
export async function createDesktopWorkspaceHost(options: DesktopWorkspaceHostOptions) {
  const router = express.Router();
  const verify = createDesktopHostVerifier(options.secret);
  const allowedOrigins = [options.gatewayOrigin, 'http://tauri.localhost', 'https://tauri.localhost', 'tauri://localhost'];
  let pointer = readWorkspacePointer(options.configRoot);
  let candidate = pointer ? null : readWorkspacePointer(options.configRoot, true);
  let gateway: WorkspaceGateway | null = null;
  let service: WorkspaceService | null = null;
  let mediaRouter: ReturnType<typeof createWorkspaceMediaRouter> | null = null;
  let operation: Promise<unknown> | null = null;
  async function open(selected: WorkspacePointer, create = false) {
    service = await openWorkspace({ root: workspaceRoot(options.configRoot, selected.workspaceId), workspaceId: selected.workspaceId, create });
    gateway = createWorkspaceGateway({ service, allowedOrigins });
    mediaRouter = createWorkspaceMediaRouter(service, gateway.authority);
  }
  if (pointer || candidate) await open((pointer || candidate)!);
  function context(): WorkspaceContext {
    if (!service) throw new WorkspaceError('WORKSPACE_UNAVAILABLE', 'Migration workspace has not been prepared', 503);
    return { workspaceId: service.workspaceId, principalId: `desktop:${options.sourceProfileId}`, protocolVersion: 1 };
  }
  async function exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (operation) throw new WorkspaceError('WORKSPACE_BUSY', 'Another host workspace operation is in progress', 409);
    const current = work(); operation = current;
    try { return await current; } finally { if (operation === current) operation = null; }
  }
  async function prepareCandidate() {
    return exclusive(async () => {
      if (pointer || candidate) return pointer || candidate;
      const selected: WorkspacePointer = { formatVersion: 1, workspaceId: randomUUID(), generation: 1, domains: [],
        activatedRevision: 0, migrationId: null, backupId: null, restoreCandidateId: null, bundledUi: false };
      await open(selected, true);
      writeWorkspacePointer(options.configRoot, selected, true);
      candidate = selected;
      return selected;
    });
  }
  async function activate(migrationId: string, bundledUi: boolean) {
    return exclusive(async () => {
      if (pointer?.migrationId === migrationId && pointer.bundledUi === bundledUi) return pointer;
      if (!service) throw new WorkspaceError('WORKSPACE_UNAVAILABLE', 'Migration candidate is not open', 503);
      const owner = context();
      const migration = await service.request({ kind: 'migration.status', migrationId }, owner);
      const alreadyActive = pointer?.migrationId === migrationId;
      if (!migration || (migration.state !== 'verified' && !(alreadyActive && migration.state === 'activated')) || migration.blockers.length
        || migration.source.sourceProfileId !== options.sourceProfileId
        || !migration.domains.includes('artwork')
        || (bundledUi && !['artwork', 'settings', 'chat', 'draft'].every(domain => migration.domains.includes(domain as 'artwork' | 'settings' | 'chat' | 'draft')))) {
        throw new WorkspaceError('MIGRATION_NOT_VERIFIED', 'All requested source domains must be verified before activation');
      }
      if (!alreadyActive && (await service.request({ kind: 'status' }, owner)).revision !== migration.revision) {
        throw new WorkspaceError('ACTIVATION_CHANGED', 'Candidate was modified after source verification');
      }
      const backup = await service.request({ kind: 'backup', operationId: randomUUID() }, owner, { timeoutMs: 120_000 });
      const restored = await service.request({ kind: 'restoreBackup', operationId: randomUUID(), backupId: backup.backupId }, owner, { timeoutMs: 120_000 });
      const status = await service.request({ kind: 'status' }, owner);
      if (restored.revision !== backup.revision || restored.mediaCount !== backup.mediaCount || status.revision !== backup.revision) {
        throw new WorkspaceError('ACTIVATION_CHANGED', 'Candidate changed during backup verification; keep source frozen and retry');
      }
      const next: WorkspacePointer = { formatVersion: 1, workspaceId: service.workspaceId,
        generation: (pointer?.generation ?? 0) + 1,
        domains: [...migration.domains],
        activatedRevision: status.revision, migrationId, backupId: backup.backupId,
        restoreCandidateId: restored.candidateId, bundledUi };
      writeWorkspacePointer(options.configRoot, next);
      pointer = next;
      await service.request({ kind: 'migration.activate', operationId: `activate:${migrationId}`,
        migrationId, expectedFingerprint: migration.fingerprint }, owner);
      return next;
    });
  }
  router.post('/api/desktop-host', express.text({ type: 'application/json', limit: '16kb' }), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (typeof req.body !== 'string') return res.status(400).json({ error: 'HOST_REQUEST' });
      const input = JSON.parse(req.body) as Record<string, unknown>;
      if (!verify(req, req.body, Number(input.timestamp), String(input.nonce))) return res.status(401).json({ error: 'HOST_AUTH' });
      if (!['atelier', 'companion', 'companion-chat'].includes(String(input.windowId))
        || input.sourceProfileId !== options.sourceProfileId || !allowedOrigins.includes(String(input.origin))) return res.status(403).json({ error: 'HOST_WINDOW' });
      if (input.action === 'shutdown') {
        await operation?.catch(() => {});
        await options.beforeClose?.();
        await gateway?.close(); gateway = null; service = null;
        return res.json({ closed: true });
      }
      if (input.action === 'prepare-candidate' || input.action === 'activate' || input.action === 'enable-bundled') {
        if (input.windowId !== 'atelier') return res.status(403).json({ error: 'HOST_ROLE' });
        if (input.action === 'enable-bundled') {
          if (!pointer?.migrationId) throw new WorkspaceError('MIGRATION_NOT_VERIFIED', 'No active verified migration');
          await activate(pointer.migrationId, true);
        }
        else if (input.action === 'prepare-candidate') await prepareCandidate();
        else if (typeof input.migrationId === 'string') await activate(input.migrationId, input.bundledUi === true);
        else return res.status(400).json({ error: 'HOST_REQUEST' });
      } else if (input.action !== 'session') return res.status(400).json({ error: 'HOST_REQUEST' });
      const session = gateway?.authority.issue({ principalId: context().principalId, origin: String(input.origin),
        scopes: input.windowId === 'atelier' ? ['workspace:read', 'workspace:write', 'workspace:backup'] : ['workspace:read', 'workspace:write'] });
      return res.json({ workspace: session ? { ...session, domains: pointer?.domains ?? [], generation: pointer?.generation ?? 0,
        bundledUi: pointer?.bundledUi ?? false } : null });
    } catch (error) {
      return res.status(error instanceof WorkspaceError ? error.status : 500).json({ error: error instanceof WorkspaceError ? error.code : 'HOST_UNAVAILABLE' });
    }
  });
  router.use('/api/workspace', (req, res, next) => {
    if (operation) return res.status(503).json({ error: '工作区正在维护', code: 'WORKSPACE_MAINTENANCE' });
    if (!gateway) return res.status(503).json({ error: '工作区尚未启用', code: 'WORKSPACE_UNAVAILABLE' });
    return mediaRouter!(req, res, error => error ? next(error) : gateway!.router(req, res, next));
  });
  return { router, get service() { return service; }, get pointer() { return pointer; }, get authority() { return gateway?.authority ?? null; },
    prepareCandidate, activate, async close() { await operation?.catch(() => {}); await options.beforeClose?.(); await gateway?.close(); } };
}
