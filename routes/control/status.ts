'use strict';

import { PathLike } from 'node:fs';

/**
 * routes/control/status.js —— 只读状态/诊断路由（2026-08-31 审计 P1-10 拆分）
 *
 * 从 routes/control.js 拆出的 5 个只读端点：/api/sd-status /api/status
 * /api/share-link /api/diagnostics /api/logs。全部无写操作、无 operation 推进；
 * 共享闭包变量统一经 ctx 注入（config/state/watchdog/refreshServiceStates 等）。
 * 状态契约（sd-status/status 降级路径/diagnostics/logs）逐字保持，前端
 * controlApi/mediaStatusApi 的 is* 校验依赖无 ok 字段的形状，不得改。
 */

let fs: typeof import('fs') = require('fs');
let security: typeof import('../../server/security') = require('../../server/security');
let diagnostics: typeof import('../../server/diagnostics') = require('../../server/diagnostics');
let envelope: typeof import('../../server/http-envelope') = require('../../server/http-envelope');
let upstreamHealth: typeof import('../../server/upstream-health') = require('../../server/upstream-health');

function registerStatusRoutes(router: any, ctx: any) {
  let localOnly = security.localOnly;

  // GET /api/sd-status — 导演台 / 出图页连接检测
  router.get('/api/sd-status', function (req: unknown, res: any) {
    let host = ctx.config.SD_HOST;
    Promise.all([
      upstreamHealth.requestJson(host, '/sdapi/v1/sd-models', null, 5000).catch(function () { return null; }),
      upstreamHealth.requestJson(host, '/sdapi/v1/samplers', null, 5000).catch(function () { return null; }),
      upstreamHealth.requestJson(host, '/sdapi/v1/schedulers', null, 5000).catch(function () { return null; }),
      upstreamHealth.requestJson(host, '/sdapi/v1/upscalers', null, 5000).catch(function () { return null; }),
      upstreamHealth.requestJson(host, '/sdapi/v1/options', null, 5000).catch(function () { return null; })
    ]).then(function (parts) {
      let modelsRes: any = parts[0];
      let online = !!(modelsRes && modelsRes.status >= 200 && modelsRes.status < 300);
      let models = online && Array.isArray(modelsRes.data)
        ? modelsRes.data.map(function (m: any) { return m.title || m.model_name || m.name || ''; }).filter(Boolean)
        : [];
      let samplers = parts[1] && Array.isArray(parts[1].data)
        ? parts[1].data.map(function (s) { return s.name || s; }).filter(Boolean)
        : [];
      let schedulers = parts[2] && Array.isArray(parts[2].data)
        ? parts[2].data.map(function (s) { return s.name || s.label || s; }).filter(Boolean)
        : [];
      let upscalers = parts[3] && Array.isArray(parts[3].data)
        ? parts[3].data.map(function (s) { return s.name || s; }).filter(Boolean)
        : [];
      let options: any = parts[4] && parts[4].data && typeof parts[4].data === 'object' ? parts[4].data : {};
      res.setHeader('Cache-Control', 'no-store');
      // 状态契约（刻意不走 envelope）：无 ok 字段，前端 mediaStatusApi.isSDStatus
      // 直接按 online/models/... 校验；探活同族端点（tts/chat-status）同形状。
      res.json({
        online: online,
        host: host,
        models: models,
        samplers: samplers,
        schedulers: schedulers,
        upscalers: upscalers,
        checkpoint: options.sd_model_checkpoint || '',
        error: online ? '' : 'SD WebUI 未响应（' + host + '）'
      });
    }).catch(function (e) {
      res.setHeader('Cache-Control', 'no-store');
      // 同上：降级路径也保持无 ok 的状态形状
      res.json({ online:false, host:host, models:[], samplers:[], schedulers:[], upscalers:[], error:e.message });
    });
  });

  // GET /api/status
  router.get('/api/status', localOnly, function(req: { query: { fresh: string; }; }, res: any) {
    // fresh=1 绕过 WebUI 状态缓存（面板的「重新检测」按钮）。
    // 这个参数以前解析了却从未被使用。
    ctx.refreshServiceStates(req.query.fresh === '1').then(function(services: any) {
      let gw = ctx.gatewayRef ? ctx.gatewayRef() : null;
      let tunnelUrl = gw ? gw.tunnelUrl : '';
      let tunnelStatus = tunnelUrl ? 'active' : (ctx.config.DISABLE_TUNNEL ? 'disabled' : 'waiting');
      let saved = ctx.readJson(ctx.config.RUNTIME.config);
      res.setHeader('Cache-Control', 'no-store');
      envelope.ok(res, {
        running: true,
        sdOnline: services.sdOnline,
        comfyOnline: services.comfyOnline,
        ttsOnline: services.ttsOnline,
        ollamaOnline: services.ollamaOnline,
        ollamaModels: services.ollamaModels,
        ollamaVram: services.ollamaVram,
        webuiManaged: services.webuiManaged,
        comfyManaged: services.comfyManaged,
        modeBusy: !!ctx.state.modeBusy,
        operation: ctx.state.operation,
        sdHost: ctx.config.SD_HOST,
        comfyHost: ctx.config.COMFY_HOST,
        ttsHost: ctx.config.TTS_HOST,
        ollamaHost: ctx.config.OLLAMA_HOST,
        localLink: 'http://127.0.0.1:' + ctx.config.PORT + '/',
        // 原始 token 不再随状态返回 —— 见 GET /api/share-link。
        shareLinkAvailable: !!tunnelUrl,
        tunnelStatus: tunnelStatus,
        tunnelAvailable: !ctx.config.DISABLE_TUNNEL && !!ctx.config.CLOUDFLARED_PATH,
        uptime: Math.floor((Date.now() - ctx.startTime) / 1000),
        autoStartVoice: !!saved.autoStartVoice,
        voices: ctx.config.VOICE_PROFILES || {},
        selfHealing: ctx.watchdog ? ctx.watchdog.status() : null,
        webBuild: ctx.webBuildInfo(ctx.config),
        scripts: {
          voiceStart: fs.existsSync(ctx.VOICE_START_SCRIPT),
          voiceStop: fs.existsSync(ctx.VOICE_STOP_SCRIPT),
          webui: fs.existsSync(ctx.WEBUI_MANAGER_SCRIPT),
          comfy: fs.existsSync(ctx.COMFY_MANAGER_SCRIPT)
        }
      });
    }).catch(function(e: any) {
      // 探测失败不是 500。三个同族接口（/api/sd-status、/api/tts-status、
      // /api/chat-status）都回 200 + online:false，只有这里回 500，
      // 于是前端 `if (!r.ok) return` 会把整块状态墙冻在上一次的值上，
      // 而用户看到的是"没反应"而不是"探测失败"。
      res.setHeader('Cache-Control', 'no-store');
      envelope.fail(res, 200, e.message || '服务状态探测失败', {
        running:true,
        degraded:true,
        sdOnline:false, comfyOnline:false, ttsOnline:false, ollamaOnline:false,
        ollamaModels:[], ollamaVram:0, webuiManaged:false, comfyManaged:false,
        modeBusy:!!ctx.state.modeBusy,
        operation:ctx.state.operation,
        sdHost:ctx.config.SD_HOST, comfyHost:ctx.config.COMFY_HOST, ttsHost:ctx.config.TTS_HOST, ollamaHost:ctx.config.OLLAMA_HOST,
        localLink:'http://127.0.0.1:' + ctx.config.PORT + '/',
        shareLinkAvailable:false,
        tunnelStatus:ctx.config.DISABLE_TUNNEL ? 'disabled' : 'waiting',
        tunnelAvailable:!ctx.config.DISABLE_TUNNEL && !!ctx.config.CLOUDFLARED_PATH,
        uptime:Math.floor((Date.now() - ctx.startTime) / 1000),
        voices:ctx.config.VOICE_PROFILES || {},
        selfHealing:ctx.watchdog ? ctx.watchdog.status() : null,
        scripts:{
          voiceStart:fs.existsSync(ctx.VOICE_START_SCRIPT),
          voiceStop:fs.existsSync(ctx.VOICE_STOP_SCRIPT),
          webui:fs.existsSync(ctx.WEBUI_MANAGER_SCRIPT), comfy:fs.existsSync(ctx.COMFY_MANAGER_SCRIPT)
        }
      });
    });
  });

  // GET /api/share-link — 含 token 的分享链接，仅本机可读。
  // 从 /api/status 拆出来：状态接口会被前端 3 秒轮询一次，
  // 把原始 token 放在里面等于任何拿到链接的人都能反过来提取 token。
  router.get('/api/share-link', localOnly, function(req: unknown, res: any) {
    let gw = ctx.gatewayRef ? ctx.gatewayRef() : null;
    let tunnelUrl = gw ? gw.tunnelUrl : '';
    res.setHeader('Cache-Control', 'no-store');
    envelope.ok(res, {
      shareLink: tunnelUrl ? (tunnelUrl + '/?token=' + encodeURIComponent(ctx.config.TOKEN)) : ''
    });
  });

  // GET /api/diagnostics
  router.get('/api/diagnostics', localOnly, function(req: unknown, res: any) {
    let saved = ctx.readJson(ctx.config.RUNTIME.config);
    // 状态契约（刻意不走 envelope）：无 ok 字段，前端 controlApi.isDiagnostics 按
    // timestamp/port/... 直接校验。
    res.json({
      timestamp: new Date().toISOString(),
      uptime: Math.floor((Date.now() - ctx.startTime) / 1000),
      port: ctx.config.PORT,
      sdHost: ctx.config.SD_HOST,
      comfyHost: ctx.config.COMFY_HOST,
      ttsHost: ctx.config.TTS_HOST,
      ollamaHost: ctx.config.OLLAMA_HOST,
      sceneShowcaseDir: ctx.config.SCENE_SHOWCASE_DIR || '',
      disableTunnel: !!ctx.config.DISABLE_TUNNEL,
      runtimeConfig: diagnostics.redactConfig(saved),
      token: diagnostics.summarizeToken(ctx.config.TOKEN),
      scripts: {
        voiceStart: ctx.VOICE_START_SCRIPT,
        voiceStop: ctx.VOICE_STOP_SCRIPT,
        webui: ctx.WEBUI_MANAGER_SCRIPT,
        comfy: ctx.COMFY_MANAGER_SCRIPT,
        voiceStartExists: fs.existsSync(ctx.VOICE_START_SCRIPT),
        voiceStopExists: fs.existsSync(ctx.VOICE_STOP_SCRIPT),
        webuiExists: fs.existsSync(ctx.WEBUI_MANAGER_SCRIPT),
        comfyExists: fs.existsSync(ctx.COMFY_MANAGER_SCRIPT)
      },
      nodeVersion: process.version,
      platform: process.platform,
      operation: ctx.state.operation
    });
  });

  // GET /api/logs — 仅本机；日志过 redactText，避免把隧道 URL / token 原样回出去
  router.get('/api/logs', localOnly, function(req: { query: { since: string; }; }, res: any) {
    let since  = parseInt(req.query.since, 10) || 0;
    // 单调序号游标：缓冲首条序号 head = seq - length；客户端落后于裁剪头时从
    // 当前头开始给（被裁掉的行此前已显示过）。total 恒为最新 seq。
    let seq = ctx.state.controlLogSeq;
    let head = seq - ctx.state.controlLogs.length;
    let from = Math.min(seq, Math.max(since, head));
    let lines  = ctx.state.controlLogs.slice(from - head).map(diagnostics.redactText);
    let logFiles = [
      ctx.config.RUNTIME && ctx.config.RUNTIME.gatewayLog,
      ctx.config.RUNTIME && ctx.config.RUNTIME.tunnelLog,
      ctx.config.RUNTIME && ctx.config.RUNTIME.controlLog,
    ].filter(Boolean);
    logFiles.forEach(function(f) {
      // readLogTail 只 seek 尾部 64KB；旧的 tailLog(f, 0) 会把整份日志读进内存再丢掉 99%
      let tail = diagnostics.readLogTail(f, 64 * 1024);
      if (!tail.available || !tail.text) return;
      lines = lines.concat(tail.text.split(/\r?\n/).filter(Boolean).slice(-30));
    });
    if (!lines.length && since === 0) {
      lines = ['[' + new Date().toISOString().slice(0,19) + '] 网关已就绪，端口 ' + ctx.config.PORT];
    }
    res.setHeader('Cache-Control', 'no-store');
    // total 是权威游标（controlLogs 单调序号），不含文件尾行（尾行每次重读、
    // 由前端按内容去重显示，不参与游标推进）。2026-08-16 审计：此前 total =
    // since + lines.length 把 ≤30×3 行文件尾算进游标且纯按环形长度计数，
    // 前端按数据长度自增 → 游标推过头/环形裁掉后，新 controlLogs 永不上屏。
    // 状态契约（刻意不走 envelope）：无 ok 字段，前端 controlApi.isLogs 按
    // logs/total/operation 直接校验。
    res.json({ logs:lines, total: seq, operation: ctx.state.operation });
  });
}

export = { registerStatusRoutes };
