'use strict';


/**
 * routes/control/services.js —— 服务启停与模式切换路由（2026-08-31 审计 P1-10 拆分）
 *
 * 从 routes/control.js 拆出的 5 个写端点：/api/service/voice|webui|ollama|comfy
 * 与 /api/mode。共享闭包（state/ops/controlLog/refreshServiceStates/runManagedScript/
 * managedScriptArgs/saveManagedDesired 等）统一经 ctx 注入。operation 推进语义
 * （ops.rejectConflict / begin / update / finish）与「目标状态已达成」「健康检查
 * 兜底」分支逐字保持，前端控制面板按 operation 驱动步骤进度条。
 */

let express: typeof import('express') = require('express');
let security: typeof import('../../server/security') = require('../../server/security');
let envelope: typeof import('../../server/http-envelope') = require('../../server/http-envelope');

function registerServiceRoutes(router: any, ctx: any) {
  let localOnly = security.localOnly;

  // POST /api/service/voice
  router.post('/api/service/voice', localOnly, express.json({ limit:'2kb' }), function(req: any, res: any) {
    let action = req.body && req.body.action;
    if (!['start', 'stop'].includes(action)) return envelope.fail(res, 400, 'action 必须是 start 或 stop');
    if (ctx.ops.rejectConflict(res)) return;
    if (action === 'start' && ctx.state.ttsOnline) {
      let fastOp = ctx.ops.begin('voice-start', '语音已在运行', ['语音已在运行', '正在验证语音服务状态']);
      ctx.ops.update(fastOp, 1);
      envelope.ok(res, { pending:true, operation:fastOp, message:'语音已在运行，正在验证…' });
      ctx.refreshServiceStates(true).then(function () {
        if (ctx.state.ttsOnline) {
          ctx.controlLog('语音已在运行，无需重复启动');
          ctx.ops.finish(fastOp, null, '语音服务已就绪');
        } else {
          ctx.ops.finish(fastOp, '语音验证失败，请检查 ' + ctx.config.TTS_HOST);
        }
      }).catch(function (e: any) { ctx.ops.finish(fastOp, e.message); });
      return;
    }
    let operation = ctx.ops.begin('voice-' + action, action === 'start' ? '启动语音服务' : '停止语音服务', [
      action === 'start' ? '正在启动 GPT-SoVITS' : '正在停止 GPT-SoVITS',
      '正在验证语音服务状态'
    ]);
    let task = action === 'start'
      ? ctx.runManagedScript(ctx.VOICE_START_SCRIPT, ['-WaitSeconds', '60'], 90000)
      : ctx.runManagedScript(ctx.VOICE_STOP_SCRIPT, [], 30000);
    task.then(async function (result: any) {
      ctx.ops.update(operation, 1);
      await ctx.refreshServiceStates(true); // 启停后缓存必然过期
      let expected = action === 'start';
      if (!result.ok && !!ctx.state.ttsOnline === expected) {
        ctx.controlLog('GPT-SoVITS 脚本返回提示，但目标状态已达成: ' + (result.error || '未知提示'));
      } else if (!result.ok) {
        throw new Error(result.error || '语音服务操作失败');
      }
      if (!!ctx.state.ttsOnline !== expected) {
        throw new Error(action === 'start'
          ? '启动脚本已结束，但语音接口尚未通过健康检查'
          : '停止脚本已结束，但语音接口仍可访问');
      }
      ctx.controlLog('GPT-SoVITS ' + (action === 'start' ? '已启动' : '已停止'));
      ctx.state.ttsManaged = action === 'start';
      ctx.ops.finish(operation, null, action === 'start' ? '语音服务已就绪' : '语音服务已停止');
    }).catch(function (error: { message: string; }) {
      ctx.controlLog('GPT-SoVITS ' + action + ' 失败: ' + error.message);
      ctx.ops.finish(operation, error.message);
    });
    envelope.ok(res, {
      pending:true, operation:operation,
      message:'语音服务正在' + (action === 'start' ? '启动（约需 30–60 秒）' : '停止')
    });
  });

  // POST /api/service/webui
  router.post('/api/service/webui', localOnly, express.json({ limit:'2kb' }), function(req: any, res: any) {
    let action = req.body && req.body.action;
    if (!['start', 'stop'].includes(action)) return envelope.fail(res, 400, 'action 必须是 start 或 stop');
    if (ctx.ops.rejectConflict(res)) return;
    if (action === 'start' && ctx.state.sdOnline) {
      let fastOp = ctx.ops.begin('webui-start', 'WebUI 已在运行', ['WebUI 已在运行', '正在验证绘图服务状态']);
      ctx.ops.update(fastOp, 1);
      envelope.ok(res, { pending:true, operation:fastOp, message:'WebUI 已在运行，正在验证…' });
      ctx.refreshServiceStates(true).then(function () {
        if (ctx.state.sdOnline) {
          ctx.controlLog('WebUI 已在运行，无需重复启动');
          ctx.ops.finish(fastOp, null, '绘图服务已就绪');
        } else {
          ctx.ops.finish(fastOp, 'WebUI 验证失败，请检查 ' + ctx.config.SD_HOST);
        }
      }).catch(function (e: any) { ctx.ops.finish(fastOp, e.message); });
      return;
    }
    let operation = ctx.ops.begin('webui-' + action, action === 'start' ? '启动绘图服务' : '停止绘图服务', [
      action === 'start' ? '正在启动 SD WebUI' : '正在停止 SD WebUI',
      '正在验证绘图服务状态'
    ]);
    if (action === 'stop') {
      ctx.state.desiredWebui = false;
      ctx.saveManagedDesired();
    }
    ctx.runManagedScript(
      ctx.WEBUI_MANAGER_SCRIPT,
      ctx.managedScriptArgs('webui', action === 'start' ? 'Start' : 'Stop'),
      action === 'start' ? ctx.WEBUI_START_TIMEOUT_MS : 120000
    ).then(async function (result: any) {
      if (result.ok && result.message) {
        try {
          let parsed = JSON.parse(result.message);
          ctx.state.webuiManaged = !!parsed.managed;
          if (parsed.message) result.message = parsed.message;
        } catch {}
      }
      ctx.ops.update(operation, 1);
      await ctx.refreshServiceStates(true); // 启停后缓存必然过期
      let expected = action === 'start';
      if (!result.ok && !!ctx.state.sdOnline === expected) {
        ctx.controlLog('WebUI 脚本返回提示，但目标状态已达成: ' + (result.error || '未知提示'));
      } else if (!result.ok) {
        throw new Error(result.error || 'WebUI 操作失败');
      }
      if (!!ctx.state.sdOnline !== expected) {
        throw new Error(action === 'start'
          ? '启动脚本已结束，但 WebUI API 尚未通过健康检查'
          : '停止脚本已结束，但 WebUI API 仍可访问');
      }
      ctx.controlLog('WebUI ' + (action === 'start' ? '已启动' : '已停止'));
      ctx.state.desiredWebui = action === 'start' && ctx.state.webuiManaged;
      ctx.saveManagedDesired();
      ctx.ops.finish(operation, null, action === 'start' ? '绘图服务已就绪' : '绘图服务已停止');
    }).catch(function (error: { message: string; }) {
      ctx.controlLog('WebUI ' + action + ' 失败: ' + error.message);
      ctx.ops.finish(operation, error.message);
    });
    envelope.ok(res, {
      pending:true, operation:operation,
      message:'WebUI 正在' + (action === 'start' ? '启动' : '停止')
    });
  });

  // POST /api/service/ollama
  router.post('/api/service/ollama', localOnly, express.json({ limit:'2kb' }), function(req: any, res: any) {
    let action = req.body && req.body.action;
    if (action !== 'unload') return envelope.fail(res, 400, 'action 目前只支持 unload');
    if (ctx.ops.rejectConflict(res)) return;
    let operation = ctx.ops.begin('ollama-unload', '释放聊天模型显存', ['正在卸载 Ollama 模型', '正在验证显存释放结果']);
    ctx.unloadOllamaModels().then(function (result: any) {
      if (!result.ok) throw new Error(result.error || 'Ollama 卸载失败');
      ctx.ops.update(operation, 1);
      return ctx.refreshServiceStates().then(function () {
        if (ctx.state.ollamaModels.length) throw new Error('仍有 ' + ctx.state.ollamaModels.length + ' 个模型占用显存');
        ctx.controlLog(result.message || 'Ollama 模型已卸载');
        ctx.ops.finish(operation, null, '聊天模型显存已释放');
      });
    }).catch(function (error: { message: string; }) {
      ctx.controlLog('Ollama 卸载失败: ' + error.message);
      ctx.ops.finish(operation, error.message);
    });
    envelope.ok(res, { pending:true, operation:operation, message:'正在卸载 Ollama 已加载模型…' });
  });

  // POST /api/service/comfy
  router.post('/api/service/comfy', localOnly, express.json({ limit:'2kb' }), function(req: any, res: any) {
    let action = req.body && req.body.action;
    if (!['start', 'stop'].includes(action)) return envelope.fail(res, 400, 'action 必须是 start 或 stop');
    if (ctx.ops.rejectConflict(res)) return;
    // 已在线时的“启动”不应再卡在 17.5%（脚本 2s 探测 + 120s 启动等待），直接走快速验证路径
    if (action === 'start' && ctx.state.comfyOnline) {
      let fastOp = ctx.ops.begin('comfy-start', 'ComfyUI 已在运行', ['ComfyUI 已在运行', '正在验证 ComfyUI /system_stats']);
      // 立即推进到 67.5%（stage 1），避免“一点点”假象
      ctx.ops.update(fastOp, 1);
      envelope.ok(res, { pending:true, operation:fastOp, message:'ComfyUI 已在运行，正在验证…' });
      ctx.refreshServiceStates(true).then(function () {
        if (ctx.state.comfyOnline) {
          ctx.state.desiredComfy = ctx.state.comfyManaged || false;
          // 若原本是手动启动，验证通过后也标记为已期望在线，避免看门狗误判
          if (!ctx.state.comfyManaged) ctx.state.desiredComfy = false;
          ctx.controlLog('ComfyUI 已在运行，无需重复启动');
          ctx.ops.finish(fastOp, null, 'ComfyUI 已在运行');
        } else {
          ctx.ops.finish(fastOp, 'ComfyUI 验证失败，请检查端口 ' + ctx.config.COMFY_HOST);
        }
      }).catch(function (e: any) { ctx.ops.finish(fastOp, e.message); });
      return;
    }
    let operation = ctx.ops.begin('comfy-' + action, action === 'start' ? '启动 ComfyUI' : '停止 ComfyUI', [
      action === 'start' ? '正在启动 ComfyUI' : '正在停止 ComfyUI',
      '正在验证 ComfyUI /system_stats'
    ]);
    if (action === 'stop') {
      ctx.state.desiredComfy = false;
      ctx.saveManagedDesired();
    }
    ctx.runManagedScript(ctx.COMFY_MANAGER_SCRIPT, ctx.managedScriptArgs('comfy', action === 'start' ? 'Start' : 'Stop'), 120000).then(async function (result: any) {
      if (result.ok && result.message) {
        try {
          let parsed = JSON.parse(result.message);
          ctx.state.comfyManaged = !!parsed.managed;
          if (parsed.message) result.message = parsed.message;
        } catch (error) {}
      }
      ctx.ops.update(operation, 1);
      await ctx.refreshServiceStates(true);
      let expected = action === 'start';
      if (!result.ok && ctx.state.comfyOnline === expected) {
        ctx.controlLog('ComfyUI 脚本返回提示，但目标状态已达成: ' + (result.error || '未知提示'));
      } else if (!result.ok) throw new Error(result.error || 'ComfyUI 操作失败');
      if (ctx.state.comfyOnline !== expected) throw new Error(action === 'start'
        ? 'ComfyUI 启动脚本已结束，但 /system_stats 尚未就绪'
        : 'ComfyUI 停止脚本已结束，但接口仍可访问');
      ctx.state.desiredComfy = action === 'start' && ctx.state.comfyManaged;
      ctx.saveManagedDesired();
      ctx.controlLog('ComfyUI ' + (action === 'start' ? '已启动' : '已停止'));
      ctx.ops.finish(operation, null, action === 'start' ? 'ComfyUI 已就绪' : 'ComfyUI 已停止');
    }).catch(function (error: { message: string; }) {
      ctx.controlLog('ComfyUI ' + action + ' 失败: ' + error.message);
      ctx.ops.finish(operation, error.message);
    });
    envelope.ok(res, { pending:true, operation:operation, message:'ComfyUI 正在' + (action === 'start' ? '启动' : '停止') });
  });

  // POST /api/mode — 绘图优先 / 聊天优先
  router.post('/api/mode', localOnly, express.json({ limit:'2kb' }), function(req: any, res: any) {
    let mode = req.body && req.body.mode;
    if (!['draw', 'chat'].includes(mode)) return envelope.fail(res, 400, 'mode 必须是 draw 或 chat');
    if (ctx.ops.rejectConflict(res)) return;
    let stages = mode === 'draw'
      ? ['正在停止语音服务', '正在卸载聊天模型', '正在启动 SD WebUI', '正在验证绘图环境']
      : ['正在释放受管 WebUI', '正在启动语音服务', '正在验证聊天环境'];
    let operation = ctx.ops.begin('mode-' + mode, mode === 'draw' ? '切换到绘图优先' : '切换到聊天优先', stages);
    ctx.state.modeBusy = true;
    envelope.ok(res, {
      pending:true, operation:operation,
      message: mode === 'draw'
        ? '正在切换到绘图优先：先释放语音与聊天模型显存，再启动 WebUI'
        : '正在切换到聊天优先：释放受管 WebUI，启动语音服务'
    });

    (async function () {
      if (mode === 'draw') {
        ctx.controlLog('模式切换：绘图优先 — 停止语音服务');
        let stopVoice = await ctx.runManagedScript(ctx.VOICE_STOP_SCRIPT, [], 30000);
        ctx.state.ttsManaged = false;
        if (!stopVoice.ok) ctx.controlLog('停止语音服务时出现提示: ' + stopVoice.error);
        ctx.ops.update(operation, 1);
        ctx.controlLog('模式切换：绘图优先 — 卸载 Ollama 模型');
        let unload = await ctx.unloadOllamaModels();
        if (!unload.ok) ctx.controlLog('Ollama 卸载提示: ' + (unload.error || unload.message || ''));
        ctx.ops.update(operation, 2);
        ctx.controlLog('模式切换：绘图优先 — 启动 WebUI');
        let startWebui = await ctx.runManagedScript(ctx.WEBUI_MANAGER_SCRIPT, ctx.managedScriptArgs('webui', 'Start'), ctx.WEBUI_START_TIMEOUT_MS);
        if (startWebui.ok) {
          try { ctx.state.webuiManaged = !!JSON.parse(startWebui.message || '{}').managed; } catch {}
          ctx.state.desiredWebui = ctx.state.webuiManaged;
          ctx.saveManagedDesired();
          ctx.controlLog('绘图优先模式就绪：显存已优先让给 WebUI');
        } else {
          throw new Error('WebUI 启动失败: ' + startWebui.error);
        }
        ctx.ops.update(operation, 3);
      } else {
        if (ctx.state.webuiManaged) {
          ctx.controlLog('模式切换：聊天优先 — 停止受管 WebUI 释放显存');
          let stopWebui = await ctx.runManagedScript(ctx.WEBUI_MANAGER_SCRIPT, ctx.managedScriptArgs('webui', 'Stop'), 60000);
          if (stopWebui.ok) {
            try { ctx.state.webuiManaged = !!JSON.parse(stopWebui.message || '{}').managed; } catch {}
            ctx.state.desiredWebui = false;
            ctx.saveManagedDesired();
          } else {
            ctx.controlLog('停止 WebUI 时出现提示: ' + stopWebui.error);
          }
        } else {
          ctx.controlLog('模式切换：聊天优先 — WebUI 为手动启动或非受管，保持不动');
        }
        ctx.ops.update(operation, 1);
        ctx.controlLog('模式切换：聊天优先 — 启动语音服务');
        let startVoice = await ctx.runManagedScript(ctx.VOICE_START_SCRIPT, ['-WaitSeconds', '60'], 90000);
        if (startVoice.ok) ctx.controlLog('聊天优先模式就绪：语音服务已启动');
        else throw new Error('语音服务启动失败: ' + startVoice.error);
        ctx.state.ttsManaged = true;
        ctx.ops.update(operation, 2);
      }
      await ctx.refreshServiceStates(true); // 模式切换刚动过服务，必须重新探测
      if (mode === 'draw' && !ctx.state.sdOnline) throw new Error('WebUI 未通过最终健康检查');
      if (mode === 'chat' && !ctx.state.ttsOnline) throw new Error('语音服务未通过最终健康检查');
      ctx.state.modeBusy = false;
      ctx.ops.finish(operation, null, mode === 'draw' ? '绘图环境已就绪' : '聊天环境已就绪');
    })().catch(function (error) {
      ctx.controlLog('模式切换失败: ' + error.message);
      ctx.refreshServiceStates();
      ctx.state.modeBusy = false;
      ctx.ops.finish(operation, error.message);
    });
  });
}

export = { registerServiceRoutes };
