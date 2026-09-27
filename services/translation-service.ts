'use strict';

import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import type { ChildProcess } from 'child_process';
import SerialQueue = require('./serial-queue');
import httpClient = require('./http-client');

interface TranslationServiceOptions {
  url: string;
  python: string;
  script: string;
  port: number | string;
  logFile: string;
}

interface TranslationResult {
  translation: string;
  error?: string;
  [key: string]: unknown;
}

interface QueueStatusView {
  name: string;
  active: number;
  pending: number;
}

interface TranslationStatus {
  ready: boolean;
  managed: boolean;
  queue: QueueStatusView;
  cached: number;
}

function killProcessTree(child: cp.ChildProcess | null): void {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    try {
      cp.execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      return;
    } catch { /* 进程可能已退出，回退到 kill */ }
  }
  try { child.kill(); } catch { /* ignore */ }
}

function createTranslationService(options: TranslationServiceOptions) {
  const queue = new SerialQueue('zh-ja-translation');
  let child: ChildProcess | null = null;
  let starting: Promise<boolean> | null = null;
  let ready = false;
  let lifecycle = new AbortController();
  /** 启动探测轮询的 handle —— close() 必须清掉它，否则关服后计时器还活着 */
  let readyPoll: ReturnType<typeof setInterval> | null = null;
  const cache = new Map<string, TranslationResult>();
  /**
   * 2026-08-16 审计：降级路径 runLegacy 每次 translate 会独立 spawn 一个一次性
   * python 子进程，此前只存在局部变量、不在 close() 清理范围 → 网关关停时孤儿进程
   * 残留。这里登记全部 legacy 子进程，close() 统一回收，close 后自动移除。
   */
  const legacyChildren = new Map<ChildProcess, () => void>();

  function remember(text: string, result: TranslationResult): TranslationResult {
    cache.delete(text);
    cache.set(text, result);
    if (cache.size > 100) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return result;
  }

  async function ping(signal?: AbortSignal | null, timeoutMs?: number): Promise<boolean> {
    try {
      const result = await httpClient.request(options.url, '/health', {
        timeoutMs: timeoutMs || 800,
        totalTimeoutMs: timeoutMs || 800,
        signal: signal || undefined
      });
      await httpClient.readBody(result.response);
      return result.response.statusCode === 200;
    } catch (error) {
      if (httpClient.isAbortError(error)) throw error;
      return false;
    }
  }

  async function requestTranslation(text: string, signal?: AbortSignal): Promise<TranslationResult> {
    const data = (await httpClient.readJson(options.url, '/translate', {
      method: 'POST',
      json: { text: text },
      timeoutMs: 120000,
      totalTimeoutMs: 120000,
      timeoutMessage: '翻译请求超时',
      signal: signal
    })) as TranslationResult | null;
    if (!data || !data.translation) throw new Error('翻译服务没有返回译文');
    return data;
  }

  function startServer(signal: AbortSignal): Promise<boolean> {
    return new Promise(function (resolve, reject) {
      let settled = false;
      let poll: ReturnType<typeof setInterval> | null = null;
      const deadline = setTimeout(() => fail(new Error('翻译常驻服务启动超时')), 120000);
      const abort = () => settle(() => reject(httpClient.abortError()));
      function settle(fn: () => void) {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (poll) clearInterval(poll);
        if (readyPoll === poll) readyPoll = null;
        signal.removeEventListener('abort', abort);
        fn();
      }
      function fail(error: Error) {
        if (child === owned) { ready = false; child = null; killProcessTree(owned); }
        settle(() => reject(error));
      }
      let owned: ChildProcess | null = null;
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      if (!fs.existsSync(options.python) || !fs.existsSync(options.script)) {
        settle(function () { reject(new Error('本地日语翻译组件尚未安装。')); });
        return;
      }

      let logFd: number | 'ignore' = 'ignore';
      try {
        fs.mkdirSync(path.dirname(options.logFile), { recursive: true });
        logFd = fs.openSync(options.logFile, 'a');
      } catch {
        // Keep translation usable even if the log file cannot be opened.
      }

      try {
        const previous = child; child = null;
        killProcessTree(previous);
        child = cp.spawn(options.python, [options.script, '--serve', '--port', String(options.port)], {
          windowsHide: true,
          env: Object.assign({}, process.env, {
            PYTHONUTF8: '1',
            AICS_TRANSLATE_PORT: String(options.port)
          }),
          stdio: ['ignore', logFd, logFd]
        });
        owned = child;
      } catch (error) {
        if (logFd !== 'ignore') fs.closeSync(logFd);
        settle(function () { reject(error); });
        return;
      }
      if (logFd !== 'ignore') fs.closeSync(logFd);

      child.once('exit', function (code, exitSignal) {
        if (child === owned) { ready = false; child = null; stopReadyPoll(); }
        // 启动窗口内退出必须结算 startServer 的 promise，否则 ensureServer
        // 的 starting 永远 pending，整条翻译队列会挂死到网关重启。
        settle(function () {
          reject(new Error('本地日语翻译组件启动后立即退出（' + (exitSignal ? 'signal ' + exitSignal : 'exit ' + code) + '），请查看日志：' + options.logFile));
        });
      });
      child.once('error', function (error) {
        fail(error);
      });

      let probing = false;
      if (readyPoll) clearInterval(readyPoll);
      poll = readyPoll = setInterval(function () {
        if (settled || probing || signal.aborted || child !== owned) return;
        probing = true;
        ping(signal, 1000)
          .then(function (online) {
            if (settled || signal.aborted || child !== owned) return;
            if (online) {
              stopReadyPoll();
              ready = true;
              console.warn('  🌐 中日翻译常驻服务已就绪 (port ' + options.port + ')');
              settle(function () { resolve(true); });
            }
          })
          .catch(function (error) { if (httpClient.isAbortError(error)) abort(); })
          .finally(function () { probing = false; });
      }, 1000);
    });
  }

  function ensureServer(signal?: AbortSignal): Promise<boolean> {
    const serviceSignal = lifecycle.signal;
    const waitSignal = signal ? AbortSignal.any([serviceSignal, signal]) : serviceSignal;
    if (waitSignal.aborted) return Promise.reject(httpClient.abortError());
    if (ready) return Promise.resolve(true);
    if (!starting) {
      const work = ping(serviceSignal, 800)
        .then(function (online) {
          if (serviceSignal.aborted) throw httpClient.abortError();
          if (online) {
            ready = true;
            return true;
          }
          return startServer(serviceSignal);
        })
        .finally(function () {
          if (starting === work) starting = null;
        });
      starting = work;
    }
    // Callers may stop waiting without cancelling another caller's shared startup.
    const work = starting;
    return new Promise<boolean>((resolve, reject) => {
      const abort = () => { cleanup(); reject(httpClient.abortError()); };
      const cleanup = () => waitSignal.removeEventListener('abort', abort);
      waitSignal.addEventListener('abort', abort, { once: true });
      work.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
  }

  function runLegacy(text: string, signal?: AbortSignal): Promise<TranslationResult> {
    return new Promise(function (resolve, reject) {
      if (!fs.existsSync(options.python) || !fs.existsSync(options.script)) {
        reject(new Error('本地日语翻译组件尚未安装。'));
        return;
      }
      if (signal && signal.aborted) {
        reject(httpClient.abortError());
        return;
      }

      let output = '';
      let errorOutput = '';
      let finished = false;
      const OUTPUT_CAP = 64 * 1024;
      const legacy = cp.spawn(options.python, [options.script], {
        windowsHide: true,
        env: Object.assign({}, process.env, { PYTHONUTF8: '1' }),
        stdio: ['pipe', 'pipe', 'pipe']
      });
      legacyChildren.set(legacy, onAbort);
      legacy.once('close', function () { legacyChildren.delete(legacy); });
      const timer = setTimeout(function () {
        if (!finished) killProcessTree(legacy);
      }, 180000);

      function onAbort() {
        if (finished) return;
        killProcessTree(legacy);
        finish(httpClient.abortError());
      }
      function finish(error?: Error | null, result?: TranslationResult) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve(result as TranslationResult);
      }

      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      if (legacy.stdout) {
        legacy.stdout.on('data', function (chunk: Buffer) {
          if (output.length < OUTPUT_CAP) output += chunk.toString('utf8').slice(0, OUTPUT_CAP - output.length);
        });
      }
      if (legacy.stderr) {
        legacy.stderr.on('data', function (chunk: Buffer) {
          if (errorOutput.length < OUTPUT_CAP) errorOutput += chunk.toString('utf8').slice(0, OUTPUT_CAP - errorOutput.length);
        });
      }
      legacy.once('error', function (error) {
        finish(error);
      });
      legacy.once('close', function (code) {
        if (finished) return;
        try {
          const result = JSON.parse(output.trim()) as TranslationResult;
          if (code === 0 && result && result.translation) {
            finish(null, result);
            return;
          }
          finish(new Error((result && result.error) || errorOutput.trim() || '本地日语翻译失败。'));
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      if (legacy.stdin) legacy.stdin.end(JSON.stringify({ text: text }));
    });
  }

  function translate(text: string, callerSignal?: AbortSignal): Promise<TranslationResult> {
    const signal = AbortSignal.any([lifecycle.signal, ...(callerSignal ? [callerSignal] : [])]);
    if (signal.aborted) return Promise.reject(httpClient.abortError());
    if (cache.has(text)) return Promise.resolve(cache.get(text) as TranslationResult);
    return queue.run(async function () {
      if (signal && signal.aborted) throw httpClient.abortError();
      try {
        await ensureServer(signal);
        return remember(text, await requestTranslation(text, signal));
      } catch (error) {
        if (signal.aborted || httpClient.isAbortError(error)) throw httpClient.abortError();
        ready = false;
        try {
          return remember(text, await runLegacy(text, signal));
        } catch (legacyError) {
          if (httpClient.isAbortError(legacyError)) throw legacyError;
          throw error;
        }
      }
    }, { signal });
  }

  function prepare(signal?: AbortSignal): Promise<boolean> {
    return ensureServer(signal);
  }

  function stopReadyPoll(): void {
    if (!readyPoll) return;
    clearInterval(readyPoll);
    readyPoll = null;
  }

  function close(): void {
    const previousLifecycle = lifecycle;
    const owned = child;
    child = null; ready = false; starting = null;
    lifecycle = new AbortController();
    previousLifecycle.abort();
    // 先停轮询：原先 close() 只 kill 子进程，那个 1 秒一次、最多 120 次的
    // setInterval 会继续跑，把事件循环拖着不让进程退出。
    stopReadyPoll();
    killProcessTree(owned);
    // 2026-08-16 审计：降级翻译子进程也要一并回收，避免网关关停后孤儿残留。
    legacyChildren.forEach(cancel => cancel());
  }

  return {
    translate: translate,
    prepare: prepare,
    ping: ping,
    close: close,
    status: function (): TranslationStatus {
      return {
        ready: ready,
        managed: !!child,
        queue: queue.status(),
        cached: cache.size
      };
    }
  };
}

export = { createTranslationService: createTranslationService };
