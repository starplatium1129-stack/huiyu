'use strict';

import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
interface ToolOptions { signal?: AbortSignal; maxBuffer?: number; cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number }
interface ToolOutput { stdout: string; stderr: string }

let cp: typeof import('child_process') = require('child_process');
let processTree: typeof import('./process-tree') = require('./process-tree');

function toolProcessError(code: string, message: string|undefined) {
  return Object.assign(new Error(message), { code: code });
}

/** Own the process until close: abort, timeout and overflow also terminate descendants. */
function runToolProcess(command: string, args: readonly string[], options: ToolOptions = {}): Promise<ToolOutput> {
  options = options || {};
  let signal = options.signal;
  if (signal && signal.aborted) return Promise.reject(toolProcessError('ABORT_ERR', '工具操作已取消'));
  return new Promise<ToolOutput>(function (resolve, reject) {
    let child: ChildProcessByStdio<null,Readable,Readable>;
    let timer: string|number|NodeJS.Timeout|undefined;
    let terminationTimer: string|number|NodeJS.Timeout|undefined;
    let stopped: Error | undefined;
    let settled = false;
    let bytes = 0;
    let stdout: Buffer[] = [];
    let stderr: Buffer[] = [];
    let limit = options.maxBuffer || 64 * 1024;

    function finish(error?: unknown, result?: ToolOutput) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(terminationTimer);
      if (signal) signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(result!); // The successful close path supplies both buffered streams.
    }
    function stop(error: Error&{ code: string; }) {
      if (settled || stopped) return;
      stopped = error;
      processTree.killProcessTree(child, { group: true, force: true });
      terminationTimer = setTimeout(function () {
        finish(toolProcessError('TERMINATION_UNCONFIRMED', '已请求停止工具，但尚未确认进程退出，请检查控制面板。'));
      }, 5000);
    }
    function abort() { stop(toolProcessError('ABORT_ERR', '工具操作已取消')); }
    function collect(target: Buffer[], chunk: Buffer) {
      if (settled || stopped) return;
      bytes += chunk.length;
      if (bytes > limit) {
        stop(toolProcessError('COMMAND_OUTPUT_LIMIT', '命令输出超过上限，已停止执行'));
        return;
      }
      target.push(chunk);
    }
    try {
      child = cp.spawn(command, args, {
        cwd: options.cwd,
        env: options.env || process.env,
        windowsHide: true,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) { finish(error); return; }
    child.stdout.on('data', function (chunk) { collect(stdout, chunk); });
    child.stderr.on('data', function (chunk) { collect(stderr, chunk); });
    child.once('error', function (error) { finish(stopped || error); });
    child.once('close', function (code, exitSignal) {
      let result = { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
      if (stopped) { finish(stopped); return; }
      if (code !== 0) {
        let detail = (result.stderr || result.stdout).trim().slice(0, 1500);
        finish(toolProcessError('COMMAND_FAILED', '命令执行失败（' + (exitSignal || code) + '）' + (detail ? '：' + detail : '')));
        return;
      }
      finish(null, result);
    });
    timer = setTimeout(function () {
      stop(toolProcessError('COMMAND_TIMEOUT', '命令执行超时，已停止执行'));
    }, options.timeout || 120000);
    if (signal) {
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    }
  });
}

export = { runToolProcess: runToolProcess };
