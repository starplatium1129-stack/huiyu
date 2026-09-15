'use strict';

const crypto: typeof import('node:crypto') = require('node:crypto');
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');

const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_STALE_MS = 6 * 60 * 60 * 1000;
const DEFAULT_POLL_MS = 250;

type LockOptions = {
  workspaceRoot: string;
  lockRoot?: string;
  waitTimeoutMs?: number;
  staleMs?: number;
  pollMs?: number;
};

type LockOwner = {
  token?: string;
  pid?: number;
  hostname?: string;
};

const isNodeError = (error: unknown): error is NodeJS.ErrnoException => error instanceof Error && 'code' in error;

function canonicalWorkspace(workspaceRoot: string): string {
  const resolved = fs.existsSync(workspaceRoot)
    ? fs.realpathSync.native(workspaceRoot)
    : path.resolve(workspaceRoot);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function desktopBuildLockPath(workspaceRoot: string, lockRoot: any = path.join(os.tmpdir(), 'aics-desktop-build-locks')): string {
  const workspace = canonicalWorkspace(workspaceRoot);
  const digest = crypto.createHash('sha256').update(workspace).digest('hex').slice(0, 24);
  return path.join(lockRoot, `${digest}.lock`);
}

function readOwner(lockPath: string): LockOwner | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
  } catch {
    return null;
  }
}

function processIsAlive(pid: number | undefined): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return isNodeError(error) && error.code === 'EPERM';
  }
}

function clearStaleLock(lockPath: string, staleMs: number): boolean {
  let stat;
  try {
    stat = fs.statSync(lockPath);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'ENOENT') return true;
    throw error;
  }

  const owner = readOwner(lockPath);
  if (owner && owner.hostname === os.hostname() && processIsAlive(owner.pid)) {
    return false;
  }
  const ownerIsDead = owner && owner.hostname === os.hostname();
  if (!ownerIsDead && Date.now() - stat.mtimeMs <= staleMs) return false;

  const stalePath = `${lockPath}.stale-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.renameSync(lockPath, stalePath);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'ENOENT') return true;
    return false;
  }
  fs.rmSync(stalePath, { recursive: true, force: true });
  return true;
}

function delay(ms: number): Promise<void> {
  return new Promise<any>((resolve: any) => setTimeout(resolve, ms));
}

async function acquireDesktopBuildLock(options: LockOptions): Promise<() => boolean> {
  const workspaceRoot = options.workspaceRoot;
  const lockPath = desktopBuildLockPath(workspaceRoot, options.lockRoot);
  const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const deadline = Date.now() + waitTimeoutMs;
  const token = crypto.randomUUID();

  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  while (true) {
    try {
      fs.mkdirSync(lockPath);
      try {
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
          token,
          pid: process.pid,
          hostname: os.hostname(),
          workspace: canonicalWorkspace(workspaceRoot),
          acquiredAt: new Date().toISOString(),
        }, null, 2) + '\n');
      } catch (error) {
        fs.rmSync(lockPath, { recursive: true, force: true });
        throw error;
      }

      return function releaseDesktopBuildLock() {
        const owner = readOwner(lockPath);
        if (!owner || owner.token !== token) return false;
        fs.rmSync(lockPath, { recursive: true, force: true });
        return true;
      };
    } catch (error: unknown) {
      if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
      if (clearStaleLock(lockPath, staleMs)) continue;
      if (Date.now() >= deadline) {
        const owner = readOwner(lockPath);
        throw new Error(`desktop build lock timeout: ${lockPath}; owner=${JSON.stringify(owner)}`);
      }
      await delay(pollMs);
    }
  }
}

async function withDesktopBuildLock<T>(options: LockOptions, callback: () => T | Promise<T>): Promise<T> {
  const release = await acquireDesktopBuildLock(options);
  try {
    return await callback();
  } finally {
    release();
  }
}

export = {
  acquireDesktopBuildLock,
  desktopBuildLockPath,
  withDesktopBuildLock,
};
