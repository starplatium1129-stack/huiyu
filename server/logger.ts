'use strict';

type LoggerOptions = { dir?: string; prefix?: string; retainDays?: number; maxBytes?: number; dailyBytesLimit?: number; debug?: boolean };
type Logger = { info(message: string, detail?: unknown): void; warn(message: string, detail?: unknown): void; error(message: string, detail?: unknown): void; debug(message: string): void };

/* eslint-disable no-console -- console 输出是本模块的职责（终端/sidecar 可见性契约），文件行另落 */

/**
 * server/logger.js — 网关最小日志设施（2026-08-21 收口）。
 *
 * 背景：网关此前 console.* 直出，无级别过滤、无时间戳、无落盘——dev 靠终端，
 * 打包模式靠 Tauri sidecar 捕获，长期运行排障只能靠重启复现。本模块保持零生产
 * 依赖，提供：
 *   1. 级别方法 info/warn/error/debug（debug 默认静默，DEBUG=1 或选项开启）；
 *   2. 按天轮转：写入 <dir>/<prefix>-YYYYMMDD.log（文件名即轮转，无重命名步骤）；
 *   3. 保留期清理：init 与日期翻转时删除超过 retainDays 的旧日志；
 *   4. 大小守卫：无日期后缀的旁路日志超过 maxBytes 时归档为按天名（复用保留期
 *      自动回收）；被外部进程占用 rename 失败则 truncate 0 保底；
 *   5. 单日落盘上限（2026-08-31）：按天日志达到 dailyBytesLimit 后当日暂停落盘
 *      仅留终端输出，防异常日刷屏把单文件撑到数十 MB，次日自动恢复；
 *   6. 落盘 fire-and-forget：appendFile 失败静默吞掉——日志永远不能弄崩网关。
 *
 * 约定：console 输出保持原样（终端/sidecar 可见性不变），文件行格式为
 * `[ISO] [LEVEL] message`；error 级别额外追加 detail（如 stack）。
 */

let fs: typeof import('fs') = require('fs');
let path: typeof import('path') = require('path');

function dateKey(d: Date) {
  let mm = String(d.getMonth() + 1).padStart(2, '0');
  let dd = String(d.getDate()).padStart(2, '0');
  return '' + d.getFullYear() + mm + dd;
}

function createLogger(options?: LoggerOptions): Logger {
  options = options || {};
  let dir = options.dir || '';
  let prefix = options.prefix || 'gateway';
  let retainDays = Number(options.retainDays) > 0 ? Number(options.retainDays) : 14;
  let maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : 8 * 1024 * 1024;
  // 单日落盘上限（2026-08-31 补，七维审计 P1「gateway 单日日志 17.85MB 失控」）：
  // 按天日志靠 retainDays 兜底总量，但异常日（刷屏 bug）单文件可以无限膨胀。
  // 达到 dailyBytesLimit 后当日仅保留终端输出，次日自动恢复。
  let dailyBytesLimit = Number(options.dailyBytesLimit) > 0 ? Number(options.dailyBytesLimit) : 20 * 1024 * 1024;
  let debugEnabled = options.debug === true || process.env.DEBUG === '1';
  let currentKey = '';
  let dailyPaused = false;
  let writesSinceCheck = 0;

  // 大小守卫（2026-08-31 补，工程审计 P1-12「runtime 日志滚动」）：
  // 无日期后缀的旁路日志（comfyui.stderr.log / control.log 等）没有按天轮转，
  // 单文件会无限增长。超过 maxBytes 时优先归档为 <name>-YYYYMMDD.log——
  // 归档文件带日期后缀，天然落入上方的按天保留期清理；rename 被占用（外部
  // 进程持句柄）则 truncate 0 保底。按天日志（-YYYYMMDD.log）不在此列。
  function guardSize(now: Date) {
    if (!dir) return;
    let today = dateKey(now);
    try {
      fs.readdirSync(dir).forEach(function (name) {
        if (!/\.log$/i.test(name)) return;
        if (/-(\d{8})\.log$/i.test(name)) return;
        let full = path.join(dir, name);
        let size;
        try { size = fs.statSync(full).size; } catch (error) { return; }
        if (size <= maxBytes) return;
        let archived = path.join(dir, name.replace(/\.log$/i, '-' + today + '.log'));
        try {
          fs.renameSync(full, archived);
          return;
        } catch (error) {}
        try { fs.truncateSync(full, 0); } catch (error) {}
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

  function checkDailySize(full: string) {
    let size = 0;
    try { size = fs.statSync(full).size; } catch (error) { return; }
    if (size <= dailyBytesLimit) return;
    dailyPaused = true;
    console.error('[logger] 当日日志 ' + path.basename(full) + ' 已达 ' +
      (size / 1024 / 1024).toFixed(1) + 'MB（单日上限 ' + (dailyBytesLimit / 1024 / 1024).toFixed(0) +
      'MB），今日落盘暂停、仅保留终端输出；疑似刷屏 bug，次日自动恢复。');
  }

  function write(level: 'info' | 'warn' | 'error' | 'debug', message: string, detail?: unknown) {
    let now = new Date();
    // 日期翻转时再做一次旧日志清理（每天最多触发一次）。
    let key = dateKey(now);
    if (key !== currentKey && dir) {
      currentKey = key;
      dailyPaused = false; // 新的一天恢复落盘
      writesSinceCheck = 0;
      guardSize(now);
      sweepRetention(now);
    }
    if (level === 'debug') {
      if (!debugEnabled) return;
      console.log('  [debug] ' + message);
    } else if (level === 'warn') {
      console.warn(message);
    } else if (level === 'error') {
      console.error(message);
    } else {
      console.log(message);
    }
    if (!dir) return;
    if (dailyPaused) return;
    let line = '[' + now.toISOString() + '] [' + level.toUpperCase() + '] ' + message;
    if (detail) {
      let errorDetail = detail instanceof Error ? detail.stack || detail.message : String(detail);
      line += ' | ' + errorDetail;
    }
    // 节流检查单日体积：每 500 次落盘做一次 statSync（高频日志下秒级一查，成本可忽略）
    writesSinceCheck++;
    if (writesSinceCheck >= 500) {
      writesSinceCheck = 0;
      checkDailySize(logFile(now));
      if (dailyPaused) return;
    }
    fs.appendFile(logFile(now), line + '\n', 'utf8', function () {});
  }

  return {
    info: function (message: string, detail?: unknown) { write('info', message, detail); },
    warn: function (message: string, detail?: unknown) { write('warn', message, detail); },
    error: function (message: string, detail?: unknown) { write('error', message, detail); },
    debug: function (message: string) { write('debug', message); }
  };
}

export = { createLogger: createLogger };
