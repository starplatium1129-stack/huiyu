import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { InterrogateOptions, InterrogateResult } from './interrogate-types';
import engine = require('./interrogate-engine');

export function createInterrogateClient() {
let worker: Worker | undefined;
let stopping = false;
let closed = false;
let pending: { resolve(value: InterrogateResult): void; reject(error: Error): void; cleanup(): void } | undefined;
const failure = (code: string, message: string, status: number) => Object.assign(new Error(message), { code, status });

function start(): Worker {
  if (worker) return worker;
  const instance = new Worker(path.join(__dirname, 'interrogate-worker.js'));
  worker = instance;
  instance.unref();
  instance.on('message', (message: { result: InterrogateResult; error?: { message: string; code?: string; status?: number } }) => {
    if (worker !== instance || stopping || !pending) return;
    const request = pending;
    pending = undefined;
    request.cleanup();
    instance.unref();
    if (message.error) request.reject(Object.assign(new Error(message.error.message), message.error));
    else request.resolve(message.result);
  });
  instance.on('error', error => {
    stopping = true;
    pending?.cleanup();
    pending?.reject(error instanceof Error ? error : new Error(String(error)));
    pending = undefined;
  });
  instance.on('exit', () => {
    if (worker !== instance) return;
    pending?.cleanup();
    pending?.reject(failure('INTERROGATE_UNAVAILABLE', 'WD14 worker stopped', 503));
    pending = undefined;
    worker = undefined;
    stopping = false;
  });
  return instance;
}

function interrogateTag(image: Buffer, options: InterrogateOptions = {}): Promise<InterrogateResult> {
  if (options.signal?.aborted) return Promise.reject(options.signal.reason);
  if (closed) return Promise.reject(failure('INTERROGATE_CLOSED', 'WD14 worker closed', 503));
  if (pending || stopping) return Promise.reject(failure('INTERROGATE_BUSY', 'WD14 正在处理另一张图片', 429));
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) return Promise.reject(new Error('Invalid WD14 timeout'));
  const instance = start();
  instance.ref();
  return new Promise((resolve, reject) => {
    const cancel = (error: Error) => {
      if (!pending || stopping) return;
      stopping = true;
      pending.cleanup();
      pending.reject(error);
      pending = undefined;
      // terminate may wait for synchronous native inference to return. Keep
      // admission closed until exit, so timeouts cannot multiply native jobs.
      void instance.terminate();
    };
    const abort = () => cancel(options.signal!.reason);
    const timer = setTimeout(() => cancel(failure('INTERROGATE_TIMEOUT', 'WD14 推理超过时限', 504)), timeoutMs);
    pending = { resolve, reject, cleanup: () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); } };
    options.signal?.addEventListener('abort', abort, { once: true });
    const { signal: _signal, config, ...rest } = options;
    const workerOptions = { ...rest, config: config ? { ROOT_DIR: config.ROOT_DIR, AI_WORKSPACE_ROOT: config.AI_WORKSPACE_ROOT } : undefined };
    try { instance.postMessage({ image, options: workerOptions }); }
    catch (error) { cancel(error as Error); }
  });
}

function close(): Promise<number | void> {
  closed = true;
  stopping = Boolean(worker);
  pending?.cleanup();
  pending?.reject(failure('INTERROGATE_CLOSED', 'WD14 worker closed', 503));
  pending = undefined;
  return worker ? worker.terminate() : Promise.resolve();
}

return { interrogateTag, close, probe: engine.probe };
}
