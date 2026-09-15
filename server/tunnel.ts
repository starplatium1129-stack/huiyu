'use strict';

import type { TunnelOptions, TunnelProcess } from './tunnel-types';

/**
 * Cloudflare Tunnel 生命周期管理。
 *
 * 从 server.js 抽出，负责 cloudflared 子进程的启动、轮询、停止与退出清理。
 * 与网关的耦合通过回调收敛：
 *   - onStateChange(): tunnelUrl 变化时通知外部（同步 gatewayState / 控制面板）
 */

let fs: typeof import('fs') = require('fs');
let cp: typeof import('child_process') = require('child_process');
let processTree: typeof import('./process-tree') = require('./process-tree');

function createTunnelManager(options: TunnelOptions) {
  options = options || {};
  let config = options.config;
  let spawn = options.spawn || cp.spawn;
  let onStateChange = options.onStateChange || function () {};

let tunnelUrl = '';
let pendingTunnelUrl = '';
let tunnelProcess: TunnelProcess | null = null;
let tunnelPoll: ReturnType<typeof setInterval> | null = null;
let tunnelStopped = false;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let restartAttempts = 0;

  let RESTART_BASE_MS = Number.isFinite(Number(options.restartBaseMs))
    ? Math.max(0, Number(options.restartBaseMs)) : 5000;
  let RESTART_MAX_MS = Number.isFinite(Number(options.restartMaxMs))
    ? Math.max(RESTART_BASE_MS, Number(options.restartMaxMs)) : 30000;
  let RESTART_LIMIT = Number.isFinite(Number(options.restartLimit))
    ? Math.max(0, Math.floor(Number(options.restartLimit))) : 10;
  let POLL_INTERVAL_MS = Number.isFinite(Number(options.pollIntervalMs))
    ? Math.max(1, Number(options.pollIntervalMs)) : 1000;

  function getUrl() {
    return tunnelUrl;
  }

  function clearUrl() {
    tunnelUrl = '';
    pendingTunnelUrl = '';
    onStateChange();
  }

  function killPids(pids: number[]) {
    pids.forEach(function (pid: number) {
      processTree.killPid(pid);
    });
  }

  // 清理上次会话残留的 cloudflared：网关被强杀时 detached 子进程没人
  // 回收，旧实例占着 metrics 端口 / trycloudflare 并发名额，新实例注册
  // 成功后会立即 exit 1，隧道永远起不来。
  function killStaleTunnel() {
    let stale = [];
    if (tunnelProcess && tunnelProcess.pid) stale.push(tunnelProcess.pid);
    try {
      let saved = fs.existsSync(config.RUNTIME.tunnelPid)
        ? String(fs.readFileSync(config.RUNTIME.tunnelPid, 'utf8')).trim()
        : '';
      if (/^\d+$/.test(saved) && stale.indexOf(Number(saved)) === -1) stale.push(Number(saved));
    } catch (error) {}
    if (stale.length) killPids(stale);
    try { if (fs.existsSync(config.RUNTIME.tunnelPid)) fs.unlinkSync(config.RUNTIME.tunnelPid); } catch (error) {}
  }

  // manual=true 表示用户/开机显式启动（重连计数清零）；自动重连传 false
  function start(manual?: boolean) {
    if (config.DISABLE_TUNNEL) return;
    if (!fs.existsSync(config.CLOUDFLARED_PATH)) {
      console.log('  ⚠ cloudflared not found, tunnel disabled');
      return;
    }
    if (tunnelProcess) return; // 已在运行，避免重复 spawn
    if (manual !== false) restartAttempts = 0;
    killStaleTunnel();
    tunnelStopped = false;
    console.log('  🌪 Starting Cloudflare Tunnel...');
    let runtimeTools: typeof import('../scripts/lib/runtime-paths') = require('../scripts/lib/runtime-paths');
    runtimeTools.rotateLog(config.RUNTIME.tunnelLog, 2 * 1024 * 1024);
    let logFd = fs.openSync(config.RUNTIME.tunnelLog, 'w');
    tunnelProcess = spawn(config.CLOUDFLARED_PATH, [
      'tunnel', '--url', 'http://localhost:' + config.PORT
    ], {
      stdio:['ignore', logFd, logFd],
      detached:true,
      windowsHide:true
    });
    tunnelProcess.unref();
    fs.closeSync(logFd);
    try { fs.writeFileSync(config.RUNTIME.tunnelPid, String(tunnelProcess.pid)); } catch (error) {}

    // cloudflared 自己挂掉时必须清空 tunnelProcess。
    // 否则 start 顶部的 `if (tunnelProcess) return` 会让后续每一次启动
    // 都变成静默 no-op，而控制面板照样收到 {ok:true}。
    let thisProcess = tunnelProcess;
    function handleTunnelExit(reason: string) {
      if (tunnelProcess !== thisProcess) return;  // 已经被 stop 换掉了
      console.log('  🌪 Tunnel process ended (' + reason + ')');
      tunnelProcess = null;
      clearUrl();
      if (tunnelPoll) { clearInterval(tunnelPoll); tunnelPoll = null; }
      scheduleRestart();
    }
    tunnelProcess.on('exit', function (code) { handleTunnelExit('exit ' + code); });
    tunnelProcess.on('error', function (error: { message: string; }) { handleTunnelExit(error.message); });

    // 自动重连：TryCloudflare 免费隧道会被 Cloudflare 侧不定期回收，
    // 进程退出后不清空状态就保持"分享中"，朋友访问只会得到 1033
    // 或连接失败。指数退避拉起（5s → 10s → …→ 30s，最多 10 次），
    // 手动点过停止就永远不再拉起。
    function scheduleRestart() {
      if (tunnelStopped) return;
      if (restartTimer) return;
      restartAttempts += 1;
      if (restartAttempts > RESTART_LIMIT) {
        console.log('  🌪 Tunnel restart limit reached, give up (share link expired)');
        return;
      }
      let delay = Math.min(RESTART_MAX_MS, RESTART_BASE_MS * restartAttempts);
      console.log('  🌪 Tunnel restart scheduled in ' + delay + 'ms (attempt ' + restartAttempts + ')');
      restartTimer = setTimeout(function () {
        restartTimer = null;
        start(false);  // 自动重连不清零计数
      }, delay);
    }

    if (tunnelPoll) { clearInterval(tunnelPoll); tunnelPoll = null; }
    let attempts = 0;
    tunnelPoll = setInterval(function () {
      // 已经点过停止就不要再把 URL 写回来
      if (tunnelStopped) { if (tunnelPoll) clearInterval(tunnelPoll); tunnelPoll = null; return; }
      try {
        let log = fs.readFileSync(config.RUNTIME.tunnelLog, 'utf8');
        let match = log.match(/https:\/\/\S+trycloudflare\.com/);
        if (match) pendingTunnelUrl = match[0];
        if (pendingTunnelUrl && /Registered tunnel connection/i.test(log)) {
          tunnelUrl = pendingTunnelUrl;
          restartAttempts = 0;  // 连接成功，重连计数清零
          onStateChange();
          console.log('  🌪 Tunnel ready (token redacted; open control panel for share link)');
          if (tunnelPoll) clearInterval(tunnelPoll); tunnelPoll = null;
        }
      } catch (error) {}
      attempts += 1;
      if (attempts > 30) { if (tunnelPoll) clearInterval(tunnelPoll); tunnelPoll = null; }
    }, POLL_INTERVAL_MS);
  }

  function stop() {
    tunnelStopped = true;
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    clearUrl();
    if (tunnelPoll) { clearInterval(tunnelPoll); tunnelPoll = null; }

    let pids = [];
    if (tunnelProcess && tunnelProcess.pid) pids.push(tunnelProcess.pid);
    // detached 进程用 taskkill /T 收掉整棵树，process.kill 杀不干净
    try {
      let saved = fs.existsSync(config.RUNTIME.tunnelPid)
        ? String(fs.readFileSync(config.RUNTIME.tunnelPid, 'utf8')).trim()
        : '';
      if (/^\d+$/.test(saved) && pids.indexOf(Number(saved)) === -1) pids.push(Number(saved));
    } catch (error) {}

    killPids(pids);
    try { if (fs.existsSync(config.RUNTIME.tunnelPid)) fs.unlinkSync(config.RUNTIME.tunnelPid); } catch (error) {}
    // 清掉日志，避免下次轮询读到上一次的旧 URL
    try { fs.writeFileSync(config.RUNTIME.tunnelLog, ''); } catch (error) {}
    tunnelProcess = null;
    console.log('  🌪 Tunnel stopped');
  }

  return {
    start:start,
    stop:stop,
    getUrl:getUrl
  };
}

export = {
  createTunnelManager:createTunnelManager
};
