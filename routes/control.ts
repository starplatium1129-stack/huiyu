import type { PathLike } from 'node:fs';
import { errorMessage as runtimeErrorMessage } from '../scripts/lib/runtime-errors';
'use strict';

import { PathOrFileDescriptor } from 'node:fs';

/**
 * routes/control.js — 控制面板 API
 * 恢复重构前 control-server 的服务启停能力：
 *   /api/status /api/start /api/stop /api/config /api/preference
 *   /api/service/voice|webui|ollama  /api/mode
 *   /api/logs /api/diagnostics
 *
 * 2026-08-31 审计 P1-10 拆分（仿 video/ 模式，压回 600 行红线内）：
 * - routes/control/web-build.js      前端构建状态与触发
 * - routes/control/script-runner.js  PowerShell 脚本执行器（进程树回收）
 * - routes/control/status.js         只读状态/诊断路由（sd-status/status/share-link/diagnostics/logs）
 * - routes/control/services.js       服务启停与模式切换路由（voice/webui/ollama/comfy/mode）
 * 本文件保留有状态编排：state/ops/watchdog、服务状态机（refreshServiceStates/
 * unloadOllamaModels/readWebuiManaged/readComfyManaged）、config/preference/start/stop/build-web。
 */

let express: typeof import('express') = require('express');
let fs: typeof import('fs')      = require('fs');
let path: typeof import('path')    = require('path');
let security: typeof import('../server/security') = require('../server/security');
let envelope: typeof import('../server/http-envelope') = require('../server/http-envelope');
// P3 收口：本机上游 JSON 请求与 SD/TTS/Comfy/Ollama 探活统一走 server/upstream-health
let upstreamHealth: typeof import('../server/upstream-health') = require('../server/upstream-health');
let localOnly = security.localOnly;
let createOperationManager = (require('../services/control-operation') as typeof import('../services/control-operation')).createOperationManager;
let createServiceWatchdog = (require('../services/service-watchdog') as typeof import('../services/service-watchdog')).createServiceWatchdog;
// 子进程登记表与进程树回收：构建进程与维护脚本共用同一份，网关退出时一并回收
let maintenanceRuntime: typeof import('./maintenance') = require('./maintenance');
let webBuild: typeof import('./control/web-build') = require('./control/web-build');
let webBuildInfo = webBuild.webBuildInfo;
let runWebBuild = webBuild.runWebBuild;
let createScriptRunner = (require('./control/script-runner') as typeof import('./control/script-runner')).createScriptRunner;
// 2026-08-31 审计 P1-10：只读状态路由 / 服务启停+模式切换路由已拆至子模块
let statusRoutes: typeof import('./control/status') = require('./control/status');
let serviceRoutes: typeof import('./control/services') = require('./control/services');

// 控制路由除 Express Router 能力外还携带生命周期成员（函数末尾赋值、server.ts 的 close() 消费，
// 与迁移前 JS 的真实契约一致），这里显式声明该形状。
type ControlRouter = import('express-serve-static-core').Router & {
  watchdog: ReturnType<typeof createServiceWatchdog>;
  close: () => void;
};

// ── 前端构建状态与触发已拆至 routes/control/web-build.js（2026-08-29 审计 P1-10）──
let WEBUI_START_TIMEOUT_MS = 6 * 60 * 1000;

function readJson(file: PathOrFileDescriptor) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
function writeJson(file: string, data: any) {
  let dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive:true });
  let tmp = file + '.' + process.pid + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n'); fs.renameSync(tmp, file); }
  catch (err) { try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {} throw err; }
}

const pingSd = upstreamHealth.pingSd;
const pingTts = upstreamHealth.pingTts;
const pingComfy = upstreamHealth.pingComfy;
const pingOllamaDetail = upstreamHealth.pingOllamaDetail;

function createControlRouter(config: any, gatewayRef: () => any, dependencies: any) {
  dependencies = dependencies || {};
  let router = express.Router() as ControlRouter;
  let persistConfig = typeof dependencies.writeJson === 'function' ? dependencies.writeJson : writeJson;
  let startTime = Date.now();
  let rootDir = config.ROOT_DIR || path.join(__dirname, '..');
  // 桌面打包版把 AI 工作区放在 AI_WORKSPACE_ROOT（可在安装目录之外），
  // 语音启停脚本必须在工作区内；回退到 appRoot 的兄弟目录（源码运行布局）。
  let voiceRoot = config.AI_WORKSPACE_ROOT || path.resolve(rootDir, '..', 'AI');
  let VOICE_START_SCRIPT = path.resolve(voiceRoot, 'Voice', 'Start-Voice.ps1');
  let VOICE_STOP_SCRIPT  = path.resolve(voiceRoot, 'Voice', 'Stop-Voice.ps1');
  let scriptsRoot = config.SCRIPTS_ROOT || path.join(rootDir, 'scripts');
  let WEBUI_MANAGER_SCRIPT = path.join(scriptsRoot, 'lib', 'managed-webui.ps1');
  let COMFY_MANAGER_SCRIPT = path.join(scriptsRoot, 'lib', 'managed-comfyui.ps1');
  let WEBUI_PACKAGE_ROOT = path.join(voiceRoot, 'Data', 'Packages', 'Stable Diffusion WebUI reForge');
  let WEBUI_IMAGES_ROOT = path.join(voiceRoot, 'Data', 'Images');
  let WEBUI_CONTROLNET_ROOT = path.join(voiceRoot, 'Data', 'Models', 'ControlNet');
  let runtimeRoot = config.RUNTIME_ROOT || (config.RUNTIME && config.RUNTIME.root) || path.join(rootDir, 'runtime');

  let state: any = {
    operation: null,
    modeBusy: false,
    webuiManaged: false,
    comfyManaged: false,
    comfyOnline: false,
    desiredWebui: false,
    desiredComfy: false,
    ttsManaged: false,
    ollamaModels: [],
    ollamaVram: 0,
    controlLogs: [],
    // 2026-08-16 审计：控制日志游标要用单调递增序号，而不是环形缓冲长度——
    // 缓冲满 200 后长度恒 200，纯长度游标再也拿不到新行。controlLogSeq 只增不减。
    controlLogSeq: 0
  };
  let ops = createOperationManager(state);
  let watchdog = null;
  try {
    let savedManaged = readJson(config.RUNTIME.config).managedServices || {};
    state.desiredWebui = savedManaged.webui === true;
    state.desiredComfy = savedManaged.comfy === true;
  } catch (error) {}

  function saveManagedDesired() {
    let saved = readJson(config.RUNTIME.config);
    saved.managedServices = { webui:!!state.desiredWebui, comfy:!!state.desiredComfy };
    persistConfig(config.RUNTIME.config, saved);
  }

  function managedScriptArgs(service: string, action: string) {
    if (service === 'webui') return [
      '-Action', action, '-PackageRoot', WEBUI_PACKAGE_ROOT, '-RuntimeRoot', runtimeRoot,
      '-WebuiHost', config.SD_HOST, '-ImagesRoot', WEBUI_IMAGES_ROOT, '-ControlNetRoot', WEBUI_CONTROLNET_ROOT
    ];
    return ['-Action', action, '-AIWorkspaceRoot', voiceRoot, '-RuntimeRoot', runtimeRoot, '-ComfyHost', config.COMFY_HOST];
  }

  function controlLog(msg: string) {
    let line = '[' + new Date().toLocaleTimeString('zh-CN', { hour12:false }) + '] ' + msg;
    state.controlLogs.push(line);
    state.controlLogSeq += 1;
    if (state.controlLogs.length > 200) state.controlLogs.shift();
    try {
      if (config.RUNTIME && config.RUNTIME.controlLog) {
        fs.appendFileSync(config.RUNTIME.controlLog, line + '\n', 'utf8');
      }
    } catch {}
    console.log(line);
  }

  // localOnly 由 server/security.js 统一提供。
  // 曾经这里有一份只比对 req.ip 的副本，而 cloudflared 是从 127.0.0.1 连进来的，
  // 于是隧道一开，所有公网请求都被判成「本机」，控制面板的启停/改 host 全部敞开。

  // PowerShell 脚本执行器已拆至 routes/control/script-runner.js（2026-08-29
  // 审计 P1-10）：连子孙终止的行为原样搬走（processTree.killProcessTree）。
  let scriptRunner = createScriptRunner({ rootDir: rootDir });
  let runScriptAsync = scriptRunner.runScriptAsync;

  let runManagedScript = typeof dependencies.runScriptAsync === 'function'
    ? dependencies.runScriptAsync
    : runScriptAsync;

  // managed-webui.ps1 -Action Status 单次实测 ~2.2 秒，而控制面板 3 秒轮询一次 →
  // 不缓存的话面板一开就永久重叠 spawn PowerShell。缓存 + in-flight 去重 + fresh=1 强制刷新。
  let WEBUI_STATUS_TTL = 15000;
  let webuiStatusCache = { at:0, managed:false, comfy:false };
  let webuiStatusInflight: any = null;

  function readWebuiManaged(force: boolean) {
    if (!fs.existsSync(WEBUI_MANAGER_SCRIPT)) return Promise.resolve(state.webuiManaged);
    let cacheFresh = Date.now() - webuiStatusCache.at < WEBUI_STATUS_TTL;
    if (!force && cacheFresh) return Promise.resolve(webuiStatusCache.managed);
    // 已有探测在飞就复用，避免并发轮询叠加 spawn
    if (webuiStatusInflight) return webuiStatusInflight;

    webuiStatusInflight = runManagedScript(WEBUI_MANAGER_SCRIPT, managedScriptArgs('webui', 'Status'), 15000)
      .then(function (status: any) {
        webuiStatusCache.at = Date.now();
        if (status.ok && status.message) {
          try {
            webuiStatusCache.managed = !!JSON.parse(status.message).managed;
          } catch (error) {
            // 输出不是合法 JSON：留个痕，别静默把旧值当新值
            controlLog('WebUI 状态脚本输出无法解析，沿用上一次结果');
          }
        }
        return webuiStatusCache.managed;
      })
      .catch(function (error: { message: string; }) {
        controlLog('WebUI 状态探测失败: ' + error.message);
        return webuiStatusCache.managed;
      })
      .finally(function () { webuiStatusInflight = null; });

    return webuiStatusInflight;
  }

  function readComfyManaged(force: boolean) {
    if (!fs.existsSync(COMFY_MANAGER_SCRIPT)) return Promise.resolve(state.comfyManaged);
    let cacheFresh = Date.now() - webuiStatusCache.at < WEBUI_STATUS_TTL;
    if (!force && cacheFresh) return Promise.resolve(webuiStatusCache.comfy);
    return runManagedScript(COMFY_MANAGER_SCRIPT, managedScriptArgs('comfy', 'Status'), 15000)
      .then(function (status: any) {
        webuiStatusCache.at = Date.now();
        if (status.ok && status.message) {
          try { webuiStatusCache.comfy = !!JSON.parse(status.message).managed; }
          catch (error) { controlLog('ComfyUI 状态脚本输出无法解析，沿用上一次结果'); }
        }
        return webuiStatusCache.comfy;
      })
      .catch(function (error: { message: string; }) {
        controlLog('ComfyUI 状态探测失败: ' + error.message);
        return webuiStatusCache.comfy;
      });
  }

  async function refreshServiceStates(force?: any) {
    if (typeof dependencies.refreshServiceStates === 'function') {
      let supplied = await dependencies.refreshServiceStates(force) || {};
      state.sdOnline = !!supplied.sdOnline;
      state.comfyOnline = !!supplied.comfyOnline;
      state.ttsOnline = !!supplied.ttsOnline;
      state.ollamaOnline = !!supplied.ollamaOnline;
      state.ollamaModels = Array.isArray(supplied.ollamaModels) ? supplied.ollamaModels : [];
      state.ollamaVram = Number(supplied.ollamaVram) || 0;
      if (typeof supplied.webuiManaged === 'boolean') state.webuiManaged = supplied.webuiManaged;
      if (typeof supplied.comfyManaged === 'boolean') state.comfyManaged = supplied.comfyManaged;
      return {
        sdOnline: state.sdOnline,
        comfyOnline: state.comfyOnline,
        ttsOnline: state.ttsOnline,
        ollamaOnline: state.ollamaOnline,
        ollamaModels: state.ollamaModels,
        ollamaVram: state.ollamaVram,
        webuiManaged: state.webuiManaged,
        comfyManaged: state.comfyManaged
      };
    }
    let results = await Promise.all([
      pingSd(config.SD_HOST, 2500),
      pingComfy(config.COMFY_HOST, 2500),
      pingTts(config.TTS_HOST, 2500),
      pingOllamaDetail(config.OLLAMA_HOST, 3000),
      readWebuiManaged(!!force),
      readComfyManaged(!!force)
    ]);
    state.sdOnline = results[0];
    state.comfyOnline = results[1];
    state.ttsOnline = results[2];
    state.ollamaOnline = results[3].online;
    state.ollamaModels = results[3].models;
    state.ollamaVram = results[3].vram;
    state.webuiManaged = results[4];
    state.comfyManaged = results[5];
    return {
      sdOnline: state.sdOnline,
      comfyOnline: state.comfyOnline,
      ttsOnline: state.ttsOnline,
      ollamaOnline: state.ollamaOnline,
      ollamaModels: state.ollamaModels,
      ollamaVram: state.ollamaVram,
      webuiManaged: state.webuiManaged,
      comfyManaged: state.comfyManaged
    };
  }

  async function unloadOllamaModels() {
    let listed: any = await upstreamHealth.requestJson(config.OLLAMA_HOST, '/api/ps', null, 4000).catch(function () { return null; });
    if (!listed || listed.status >= 300) return { ok:false, error:'Ollama 未响应' };
    let models = Array.isArray(listed.data && listed.data.models) ? listed.data.models : [];
    if (!models.length) return { ok:true, message:'Ollama 没有已加载的模型' };
    let unloaded = 0;
    for (let i = 0; i < models.length; i += 1) {
      let name = String(models[i].name || models[i].model || '');
      if (!name) continue;
      let result = await upstreamHealth.requestJson(config.OLLAMA_HOST, '/api/generate', { model:name, keep_alive:0, stream:false }, 20000).catch(function () { return null; });
      if (result && result.status < 300) unloaded += 1;
    }
    await refreshServiceStates();
    return { ok: unloaded > 0 || models.length === 0, message: '已卸载 ' + unloaded + ' 个 Ollama 模型，显存已释放' };
  }

  // ── 只读状态路由（/api/sd-status、/api/status、/api/share-link、/api/diagnostics、
  //    /api/logs）与服务启停+模式切换路由（/api/service/*、/api/mode）已拆至
  //    routes/control/{status,services}.js —— ctx 承载共享闭包，watchdog 下方创建后回填
  //    （子模块路由在请求期才读 ctx.watchdog，注册期为 null 无碍）。──
  let ctx: any = {
    config: config,
    gatewayRef: gatewayRef,
    state: state,
    ops: ops,
    watchdog: null,
    startTime: startTime,
    controlLog: controlLog,
    refreshServiceStates: refreshServiceStates,
    unloadOllamaModels: unloadOllamaModels,
    runManagedScript: runManagedScript,
    managedScriptArgs: managedScriptArgs,
    saveManagedDesired: saveManagedDesired,
    readJson: readJson,
    webBuildInfo: webBuildInfo,
    VOICE_START_SCRIPT: VOICE_START_SCRIPT,
    VOICE_STOP_SCRIPT: VOICE_STOP_SCRIPT,
    WEBUI_MANAGER_SCRIPT: WEBUI_MANAGER_SCRIPT,
    COMFY_MANAGER_SCRIPT: COMFY_MANAGER_SCRIPT,
    WEBUI_START_TIMEOUT_MS: WEBUI_START_TIMEOUT_MS
  };
  statusRoutes.registerStatusRoutes(router, ctx);
  serviceRoutes.registerServiceRoutes(router, ctx);

  // POST /api/start — 启动公网隧道
  // enableTunnel=false（控制面板开关关闭）时不得启动：UI 承诺与实际行为
  // 必须一致，否则用户关掉开关后点主按钮照样开隧道。
  router.post('/api/start', localOnly, express.json({ limit:'2kb' }), function(req, res) {
    try {
      let enableTunnel = req.body && req.body.enableTunnel === false ? false : true;
      if (!enableTunnel) {
        return envelope.ok(res, { message:'公网分享已保持关闭（开关未开启）' });
      }
      let gw: any = gatewayRef ? gatewayRef() : null;
      if (gw && typeof gw.startTunnel === 'function') gw.startTunnel();
      // 记住偏好：下次启动网关时自动开分享
      try {
        let saved = readJson(config.RUNTIME.config);
        saved.autoTunnel = true;
        persistConfig(config.RUNTIME.config, saved);
      } catch (e) {}
      controlLog('公网分享通道已请求启动');
      envelope.ok(res, { message:'公网分享通道已启动' });
    } catch(e) {
      envelope.fail(res, 500, runtimeErrorMessage(e));
    }
  });

  // POST /api/stop — 停止公网隧道（不动网关与生成服务）
  router.post('/api/stop', localOnly, express.json({ limit:'2kb' }), function(req, res) {
    try {
      let gw: any = gatewayRef ? gatewayRef() : null;
      if (gw && typeof gw.stopTunnel === 'function') gw.stopTunnel();
      // 记住偏好：下次不再自动开分享，否则重启后又会“自己打开”
      try {
        let saved = readJson(config.RUNTIME.config);
        saved.autoTunnel = false;
        persistConfig(config.RUNTIME.config, saved);
      } catch (e) {}
      controlLog('公网分享通道已停止');
      envelope.ok(res, { message:'公网分享通道已停止' });
    } catch(e) {
      envelope.fail(res, 500, runtimeErrorMessage(e));
    }
  });

  // POST /api/config
  router.post('/api/config', localOnly, express.json({ limit:'8kb' }), function(req, res) {
    try {
      let body = req.body || {};
      let saved = readJson(config.RUNTIME.config);
      let configUpdates = [];
      let nextVoiceProfiles = null;
      // 三个上游 host 必须落在本机 http。不校验的话这里是 SSRF，
      // 而且值会落盘 → 重启后 /sdapi 代理会指向攻击者选定的地址。
      let hostFields = [
        { key:'sdHost',     configKey:'SD_HOST',     label:'SD' },
        { key:'comfyHost',  configKey:'COMFY_HOST',  label:'ComfyUI' },
        { key:'ttsHost',    configKey:'TTS_HOST',    label:'语音' },
        { key:'ollamaHost', configKey:'OLLAMA_HOST', label:'Ollama' }
      ];
      for (let i = 0; i < hostFields.length; i += 1) {
        let field = hostFields[i];
        if (!body[field.key]) continue;
        let safe = security.safeLocalUrl(body[field.key]);
        if (!safe) {
          return envelope.fail(res, 400,
            field.label + ' 地址只接受本机 http，例如 http://127.0.0.1:7860');
        }
        saved[field.key] = safe;
        configUpdates.push({ key:field.configKey, value:safe });
      }
      if (body.voices && typeof body.voices === 'object') {
        saved.voices = body.voices;
        nextVoiceProfiles = body.voices;
      }
      if (typeof body.autoStartVoice === 'boolean') saved.autoStartVoice = body.autoStartVoice;
      persistConfig(config.RUNTIME.config, saved);
      configUpdates.forEach(function (update) { config[update.key] = update.value; });
      if (nextVoiceProfiles) config.VOICE_PROFILES = nextVoiceProfiles;
      controlLog('服务配置已保存');
      envelope.ok(res, { sdHost:config.SD_HOST, comfyHost:config.COMFY_HOST, ttsHost:config.TTS_HOST, ollamaHost:config.OLLAMA_HOST });
    } catch(e) {
      envelope.fail(res, 500, runtimeErrorMessage(e));
    }
  });

  // POST /api/preference
  router.post('/api/preference', localOnly, express.json({ limit:'2kb' }), function(req, res) {
    try {
      let body = req.body || {};
      let saved = readJson(config.RUNTIME.config);
      if (typeof body.autoStartVoice === 'boolean') saved.autoStartVoice = body.autoStartVoice;
      persistConfig(config.RUNTIME.config, saved);
      envelope.ok(res, { autoStartVoice: !!saved.autoStartVoice });
    } catch(e) {
      envelope.fail(res, 500, runtimeErrorMessage(e));
    }
  });

  // 重新构建前端：公网分享伺服 dist/，源码改动后不重建分享出去就是旧版
  router.post('/api/maintenance/build-web', localOnly, function (req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (maintenanceRuntime.isDesktopPackagedMode(config)) {
      return envelope.fail(res, 501, '桌面应用模式下无法重新构建前端（源码不在安装包内）。' +
        '请在源码开发模式中执行 npm run build。', { code:'DESKTOP_MAINTENANCE_UNAVAILABLE' });
    }
    runWebBuild(config, function (result: any) {
      let payload = Object.assign({ durationMs:result.durationMs, error:result.error, tail:result.tail }, { webBuild:webBuildInfo(config) });
      if (!result.ok) return envelope.fail(res, 500, result.error || '前端构建失败', payload);
      return envelope.ok(res, payload);
    });
  });

  // 服务自愈看门狗：GPT-SoVITS / 翻译进程崩溃后自动拉起（指数退避）。
  // 只有"曾在线且受管"的服务才自动重启，未启动过的一律不动。
  watchdog = createServiceWatchdog({
    intervalMs: Number(config.SELF_HEALING_INTERVAL_MS) || 5000,
    maxBackoffMs: 30000,
    services: [
      {
        name: 'webui',
        probe: function () { return pingSd(config.SD_HOST, 2500); },
        restart: function () {
          return runManagedScript(WEBUI_MANAGER_SCRIPT, managedScriptArgs('webui', 'Start'), WEBUI_START_TIMEOUT_MS)
            .then(function (result: any) { return { ok:!!result.ok, error:result.error }; });
        },
        shouldManage: function () { return state.desiredWebui; },
        recoverOnStart: function () { return state.desiredWebui; }
      },
      {
        name: 'comfy',
        probe: function () { return pingComfy(config.COMFY_HOST, 2500); },
        restart: function () {
          return runManagedScript(COMFY_MANAGER_SCRIPT, managedScriptArgs('comfy', 'Start'), 120000)
            .then(function (result: any) { return { ok:!!result.ok, error:result.error }; });
        },
        shouldManage: function () { return state.desiredComfy; },
        recoverOnStart: function () { return state.desiredComfy; }
      },
      {
        name: 'tts',
        probe: function () { return pingTts(config.TTS_HOST, 2500); },
        restart: function () {
          return runManagedScript(VOICE_START_SCRIPT, ['-WaitSeconds', '60'], 90000)
            .then(function (result: any) { return { ok: !!result.ok, error: result.error }; });
        },
        shouldManage: function () {
          if (state.ttsManaged) return true;
          try { return !!readJson(config.RUNTIME.config).autoStartVoice; } catch (error) { return false; }
        }
      },
      {
        name: 'translation',
        probe: function () {
          return dependencies.translation ? dependencies.translation.ping() : Promise.resolve(false);
        },
        restart: function () {
          if (!dependencies.translation) return Promise.resolve({ ok: false, error: '翻译服务不可用' });
          return dependencies.translation.prepare()
            .then(function () { return { ok: true }; })
            .catch(function (error: any) {
              return { ok: false, error: (error && error.message) || '翻译服务重启失败' };
            });
        },
        shouldManage: function () {
          if (!dependencies.translation) return false;
          return fs.existsSync(config.TRANSLATION_PYTHON) && fs.existsSync(config.TRANSLATION_SCRIPT);
        }
      }
    ],
    onEvent: function (event) {
      controlLog('自愈看门狗 ' + event.service + ' → ' + event.kind
        + (event.error ? '：' + event.error : '')
        + (event.attempt ? '（第 ' + event.attempt + ' 次）' : ''));
    }
  });
  ctx.watchdog = watchdog;

  watchdog.start();

  // 启动时探测一次受管 WebUI 状态
  refreshServiceStates().catch(function () {});

  router.watchdog = watchdog;
  router.close = function () { if (watchdog) watchdog.stop(); };
  return router;
}

export = {
  createControlRouter,
  // 暴露给测试：断言这里用的是 server/security 的共享实现，而不是又一份本地副本
  _test:{ localOnly }
};
