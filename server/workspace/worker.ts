import { parentPort, workerData } from 'node:worker_threads';
import { openWorkspaceEngine } from './engine';
import { WorkspaceError, isWorkspaceMutation, type WorkspaceCommand, type WorkspaceContext } from './types';

interface RequestMessage { type: 'request'; id: number; command: WorkspaceCommand; context: WorkspaceContext; cancellation: SharedArrayBuffer }
const port = parentPort;
if (!port) throw new Error('Workspace storage must run in its dedicated worker');
const failure = (error: unknown, command?: WorkspaceCommand) => error instanceof WorkspaceError
  ? { code: error.code, message: error.message, status: error.status }
  : command && isWorkspaceMutation(command)
    ? { code: 'COMMIT_UNKNOWN', message: 'Storage mutation outcome must be checked by operation identity', status: 503 }
    : { code: 'STORAGE_UNAVAILABLE', message: 'Workspace storage operation failed', status: 503 };

async function start() {
  let engine: ReturnType<typeof openWorkspaceEngine>;
  try { engine = openWorkspaceEngine(workerData); }
  catch (error) { port!.postMessage({ type: 'startup-error', error: failure(error) }); port!.close(); return; }
  let tail = Promise.resolve();
  let closing = false;
  let background: Promise<void> | undefined;
  port!.on('message', (message: RequestMessage | { type: 'close' }) => {
    if (closing) return;
    if (message.type === 'close') {
      closing = true;
      tail = tail.then(async () => { await background; engine.close(); port!.postMessage({ type: 'closed' }); port!.close(); });
      void tail.catch(() => process.exit(1));
      return;
    }
    tail = tail.then(() => {
      const cancellation = new Int32Array(message.cancellation);
      const isCancelled = () => Atomics.load(cancellation, 0) !== 0;
      const copy = message.command.kind === 'backup' || message.command.kind === 'restoreBackup';
      if (copy && background) {
        port!.postMessage({ type: 'result', id: message.id, error: failure(new WorkspaceError('WORKSPACE_BUSY', 'A workspace copy is already running', 429)) });
        return;
      }
      let release!: () => void;
      const lane = new Promise<void>(resolve => { release = resolve; });
      const work = (async () => {
        try {
          if (isCancelled()) throw new WorkspaceError('ABORTED', 'Workspace request was cancelled', 499);
          const value = await engine.execute(message.command, message.context, { isCancelled, ...(copy ? { onCopyReady: release } : {}) });
          port!.postMessage({ type: 'result', id: message.id, value });
        } catch (error) { port!.postMessage({ type: 'result', id: message.id, error: failure(error, message.command) }); }
        finally { release(); }
      })();
      if (!copy) return work;
      background = work.finally(() => { background = undefined; });
      void background.catch(() => process.exit(1));
      return lane;
    });
    void tail.catch(() => process.exit(1));
  });
  port!.postMessage({ type: 'ready' });
}
void start();
