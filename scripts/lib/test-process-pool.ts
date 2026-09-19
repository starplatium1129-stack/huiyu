import { spawn, type ChildProcess } from 'node:child_process';

export interface TestProcessEntry { name: string; file: string; args?: readonly string[] }
export interface TestProcessResult { name: string; ok: boolean; duration: number; reason: string; output: string }
export interface TestPoolOptions {
  cwd: string;
  jobs: number;
  timeoutMs: number;
  maxOutputBytes?: number;
  keepGoing?: boolean;
  signal?: AbortSignal;
  onResult?: (result: TestProcessResult) => void;
}

/** Only terminate the process tree created by this runner. No shell interpolation. */
function killOwnedTree(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => child.kill('SIGKILL'));
    killer.on('close', code => { if (code !== 0) child.kill('SIGKILL'); });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}

function runNode(entry: TestProcessEntry, options: TestPoolOptions): Promise<TestProcessResult> {
  const started = Date.now();
  return new Promise(resolve => {
    const child = spawn(process.execPath, [entry.file, ...(entry.args || [])], {
      cwd: options.cwd, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    let reason = '';
    let size = 0;
    const chunks: Buffer[] = [];
    const max = options.maxOutputBytes ?? 64 * 1024 * 1024;
    const stop = (message: string) => {
      if (reason) return;
      reason = message;
      killOwnedTree(child);
    };
    const abort = () => stop('INTERRUPTED');
    const timer = setTimeout(() => stop(`TIMEOUT(${options.timeoutMs}ms)`), options.timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const capture = (chunk: Buffer) => {
      const remaining = max - size;
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      size += chunk.length;
      if (size > max) stop(`OUTPUT_LIMIT(${max})`);
    };
    child.stdout!.on('data', capture);
    child.stderr!.on('data', capture);
    child.on('error', error => { reason ||= error.message; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      reason ||= signal ? `signal ${signal}` : code !== 0 ? `exit ${code ?? '?'}` : '';
      resolve({ name: entry.name, ok: !reason, reason, duration: Date.now() - started, output: Buffer.concat(chunks).toString('utf8') });
    });
  });
}

/** On failure stop dispatching, then settle already-running owners before returning. */
export async function runTestProcessPool(entries: readonly TestProcessEntry[], options: TestPoolOptions) {
  if (!Number.isInteger(options.jobs) || options.jobs < 1 || options.jobs > 4) throw new Error('Test jobs must be an integer from 1 to 4');
  const results: TestProcessResult[] = [];
  let cursor = 0;
  let failed = false;
  async function worker() {
    while (cursor < entries.length && !options.signal?.aborted && (!failed || options.keepGoing)) {
      const entry = entries[cursor++];
      try {
        const result = await runNode(entry, options);
        results.push(result);
        if (!result.ok) failed = true;
        options.onResult?.(result);
      } catch (error) { failed = true; throw error; }
    }
  }
  const completed = await Promise.allSettled(Array.from({ length: Math.min(options.jobs, entries.length) }, worker));
  for (const result of completed) if (result.status === 'rejected') throw result.reason;
  return { results, skipped: entries.length - results.length, interrupted: options.signal?.aborted === true };
}
