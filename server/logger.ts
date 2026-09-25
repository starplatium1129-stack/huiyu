'use strict';

type LoggerOptions = { dir?: string; prefix?: string; retainDays?: number; maxBytes?: number; dailyBytesLimit?: number; debug?: boolean };
type Logger = { info(message: string, detail?: any): void; warn(message: string, detail?: any): void; error(message: string, detail?: any): void; debug(message: string): void };

/** Local diagnostics: bounded writes, credential redaction and non-destructive rotation.
 * No cross-process hard quota is claimed; reservations cover this logger's pending writes.
 */

let fs: typeof import('fs') = require('fs');
let path: typeof import('path') = require('path');

function dateKey(d: Date) {
  let mm = String(d.getMonth() + 1).padStart(2, '0');
  let dd = String(d.getDate()).padStart(2, '0');
  return '' + d.getFullYear() + mm + dd;
}

function positiveOption(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
function safeText(value: unknown): string {
  let text: string;
  try { text = value instanceof Error ? value.stack || value.message : String(value); }
  catch { return '[unprintable detail]'; }
  // Redact before truncation, in both file and terminal output. This is not a
  // general-purpose secret detector: callers must still avoid logging raw bodies.
  return text.replace(/(https?:\/\/)[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/([?&](?:token|access_token|api[-_]?key)=)[^&#\s"']*/gi, '$1[REDACTED]')
    .replace(/(\baics_token=)[^;\s"']*/gi, '$1[REDACTED]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.~-]+/gi, '$1 [REDACTED]')
    .replace(/\r/g, '\\r').replace(/\n/g, '\\n')
    .slice(0, 4096);
}

function createLogger(options?: LoggerOptions): Logger {
  options = options || {};
  let dir = options.dir || '';
  let prefix = options.prefix && /^[\w-][\w.-]*$/.test(options.prefix) ? options.prefix : 'gateway';
  let retainDays = positiveOption(options.retainDays, 14);
  let maxBytes = positiveOption(options.maxBytes, 8 * 1024 * 1024);
  // 单日落盘上限（2026-08-31 补，七维审计 P1「gateway 单日日志 17.85MB 失控」）：
  // 按天日志靠 retainDays 兜底总量，但异常日（刷屏 bug）单文件可以无限膨胀。
  // 达到 dailyBytesLimit 后当日仅保留终端输出，次日自动恢复。
  let dailyBytesLimit = positiveOption(options.dailyBytesLimit, 20 * 1024 * 1024);
  let debugEnabled = options.debug === true || process.env.DEBUG === '1';
  let currentKey = '';
  let dailyPaused = false;
  let reservedBytes = 0;

  // Never overwrite an earlier archive or truncate a log merely because rotation failed.
  function guardSize(now: Date) {
    if (!dir) return;
    let today = dateKey(now);
    try {
      fs.readdirSync(dir).forEach(function (name) {
        if (!/\.log$/i.test(name)) return;
        if (/-(\d{8})\.log$/i.test(name)) return;
        let full = path.join(dir, name);
        let size;
        try { const stat = fs.lstatSync(full); if (!stat.isFile()) return; size = stat.size; } catch (error) { return; }
        if (size <= maxBytes) return;
        let archived = path.join(dir, name.replace(/\.log$/i, '-' + today + '.log'));
        for (let i = 1; fs.existsSync(archived); i++) {
          if (i > 1000) return;
          archived = path.join(dir, name.replace(/\.log$/i, '.' + i + '-' + today + '.log'));
        }
        try {
          fs.renameSync(full, archived);
          return;
        } catch (error) {}
      });
    } catch (error) {}
  }

  function sweepRetention(now: Date) {
    if (!dir) return;
    let cutoff = new Date(now.getTime() - retainDays * 24 * 60 * 60 * 1000);
    let cutoffKey = dateKey(cutoff);
    try {
      fs.readdirSync(dir).forEach(function (name) {
        if (!/\.log$/i.test(name)) return;
        let full = path.join(dir, name);
        try { if (!fs.lstatSync(full).isFile()) return; } catch { return; }
        // 2026-08-28 审计 P1-11：此前只回收本 prefix 的按天日志，comfyui/control/
        // translate 等旁路日志与收口前的旧格式残留永远无人清理。改为双判据：
        // - 任意 <name>-YYYYMMDD.log 按文件名日期判过期（自己的旧按天日志不变）；
        // - 无日期后缀的旁路日志按 mtime 判过期（活跃文件不受影响）。
        let dated = /-(\d{8})\.log$/i.exec(name);
        if (dated) {
          if (dated[1] >= cutoffKey) return;
        } else {
          let mtime;
          try { mtime = fs.statSync(full).mtime; } catch (error) { return; }
          if (mtime >= cutoff) return;
        }
        try { fs.unlinkSync(full); } catch (error) {}
      });
    } catch (error) {}
  }

  // init 即清理一次过期日志：即使本会话一行日志都不写，陈旧文件也该被回收。
  if (dir) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (error) {}
    guardSize(new Date());
    sweepRetention(new Date());
  }

  function logFile(now: Date) {
    return path.join(dir, prefix + '-' + dateKey(now) + '.log');
  }

  function write(level: 'info' | 'warn' | 'error' | 'debug', message: string, detail?: any) {
    if (level === 'debug' && !debugEnabled) return;
    const now = new Date();
    const key = dateKey(now);
    if (key !== currentKey && dir) {
      currentKey = key;
      dailyPaused = false;
      guardSize(now);
      sweepRetention(now);
      try {
        const stat = fs.lstatSync(logFile(now));
        reservedBytes = stat.isFile() ? stat.size : dailyBytesLimit;
      } catch { reservedBytes = 0; }
    }
    const safeMessage = safeText(message);
    try {
      const output = (level === 'debug' ? '  [debug] ' : '') + safeMessage + '\n';
      if (level === 'warn' || level === 'error') process.stderr.write(output);
      else process.stdout.write(output);
    } catch { /* A broken diagnostic sink must not fail the caller. */ }
    if (!dir || dailyPaused) return;
    let line = '[' + now.toISOString() + '] [' + level.toUpperCase() + '] ' + safeMessage;
    if (detail) line += ' | ' + safeText(detail);
    line += '\n';
    const bytes = Buffer.byteLength(line);
    // Reserve BEFORE appendFile: hundreds of async writes can be queued before a
    // stat sees any of them. Also account for a pre-existing log on the first write.
    if (reservedBytes + bytes > dailyBytesLimit) {
      dailyPaused = true;
      try { process.stderr.write('[logger] 当日日志已达写入预算，今日暂停落盘、保留终端输出。\n'); } catch {}
      return;
    }
    reservedBytes += bytes;
    try {
      fs.appendFile(logFile(now), line, { encoding:'utf8', mode:0o600 }, function (error) {
        if (error && currentKey === key) reservedBytes = Math.max(0, reservedBytes - bytes);
      });
    } catch {
      if (currentKey === key) reservedBytes = Math.max(0, reservedBytes - bytes);
    }
  }

  return {
    info: function (message: string, detail?: any) { write('info', message, detail); },
    warn: function (message: string, detail?: any) { write('warn', message, detail); },
    error: function (message: string, detail?: any) { write('error', message, detail); },
    debug: function (message: string) { write('debug', message); }
  };
}

export = { createLogger: createLogger };
