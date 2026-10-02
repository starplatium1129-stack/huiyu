import cp from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
interface TreeOptions { group?: boolean; force?: boolean }

// Local tool cleanup: terminate spawned descendants as well as their parent.
function killProcessTree(child: Pick<ChildProcess, 'pid' | 'kill'> | null | undefined, options?: TreeOptions) {
  if (!child || !child.pid) return;
  options = options || {};
  if (process.platform === 'win32') {
    try {
      cp.execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5000 });
      return true;
    } catch (error) { /* 进程可能已退出，回退到 kill */ }
  }
  if (options.group && process.platform !== 'win32') {
    try { process.kill(-child.pid, options.force ? 'SIGKILL' : 'SIGTERM'); return true; } catch (error) {}
  }
  try { return child.kill(options.force ? 'SIGKILL' : 'SIGTERM'); } catch (error) { return false; }
}

export { killProcessTree };
