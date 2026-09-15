'use strict';

const { test }: typeof import('node:test') = require('node:test');

test("Resource scheduling tests passed: VRAM modes, service controls, persistent translation, Ollama keep_alive, tunnel opt-in", () => {
/**
 * 显存资源调度契约
 *
 * 重构前断言 tools/control-server.js + control.html/control.js。
 * 那套独立 3001 进程已合并进主网关：routes/control.js + src/views/ControlView.vue。
 * 2026-08-31 起写端点再拆至 routes/control/services.js、只读状态拆至 status.js、
 * 长脚本执行拆至 script-runner.js——断言改为跨 control 路由模块联合匹配，
 * 并校验 control.js 真正挂载了拆分模块，不再把断言钉死在单一源码位置
 * （审计 2026-09-05 P2-01）。
 * 保障目标不变：
 *   1. 网关让 Ollama 空闲自动释放显存、限制上下文、换模型前先卸载
 *   2. 常驻翻译服务 + 回退路径 + 健康检查
 *   3. 控制面板后端暴露单服务启停、模式切换、Ollama 卸载，并串行化 GPU 操作
 *   4. 控制面板前端提供模式卡、单服务按钮、操作进度、显存状态
 */

const fs: typeof import('fs') = require('fs');
const path: typeof import('node:path') = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const control = read('routes', 'control.js');
const controlServices = read('routes', 'control', 'services.js');
const controlStatus = read('routes', 'control', 'status.js');
// 写端点/只读状态/模式切换分散在三个拆分模块中，契约按"control 路由族"整体匹配
const controlRoutes = control + controlServices + controlStatus;
const controlView = read('src', 'views', 'ControlView.vue');
// 控制面板脚本已按状态所有权拆出：自动启停偏好归 useControlActions
const controlActions = read('src', 'composables', 'useControlActions.ts');
const controlApi = read('src', 'api', 'controlApi.ts');
const gatewayConfig = read('server', 'config.js');
const ollamaService = read('services', 'ollama-service.js');
const translationService = read('services', 'translation-service.js');
const translatePy = read('tools', 'translate-zh-ja.py');
const server = read('server.js');

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error('[resource] ' + message);
}

// ─── 网关：Ollama 显存自动释放 + 常驻翻译服务 ───
assert(/keep_alive\s*:\s*keepAlive/.test(ollamaService), 'gateway must pass keep_alive so Ollama unloads idle models from VRAM');
assert(gatewayConfig.includes("OLLAMA_KEEP_ALIVE:env.OLLAMA_KEEP_ALIVE || '10m'"), 'gateway must default Ollama keep_alive to 10 minutes');
assert(/num_ctx\s*:\s*numContext/.test(ollamaService), 'gateway must cap Ollama context window to limit VRAM usage');
assert(/async function unload/.test(ollamaService) && ollamaService.includes('activeModel'), 'gateway must unload old model before loading a different one to avoid double VRAM consumption');
assert(translationService.includes('ensureServer') && translationService.includes("'--serve'"), 'gateway must manage a persistent translation server');
assert(translationService.includes('runLegacy'), 'gateway must keep the spawn-per-call translation as fallback');
assert(translationService.includes('}, { signal });'), 'aborted translation requests must leave the pending queue immediately');
assert(/prepare\s*:\s*prepare/.test(translationService), 'voice clients must be able to prewarm the translation model');
assert(gatewayConfig.includes('TRANSLATE_PORT') && translationService.includes("'/health'"), 'gateway must health-check the translation server');

// ─── 翻译脚本：常驻服务模式 ───
assert(translatePy.includes('ThreadingHTTPServer') && translatePy.includes('/translate'), 'translate script must serve HTTP in --serve mode');
assert(translatePy.includes('load_model()'), 'translate script must load the model once');
assert(translatePy.includes('_MODEL_LOCK'), 'translate script must serialize concurrent translations');
assert(translatePy.includes('batch_decode') && translatePy.includes('TRANSLATION_BEAMS'), 'translation must batch sentences and default to low-latency decoding');

// ─── 控制面板后端：服务调度（跨 control 路由族联合断言） ───
assert(
  control.includes("require('./control/services')") && control.includes('serviceRoutes'),
  'control.js must mount the split service routes module',
);
assert(controlRoutes.includes("'/api/service/voice'"), 'control routes must expose voice start/stop endpoint');
assert(controlRoutes.includes("'/api/service/webui'"), 'control routes must expose webui start/stop endpoint');
assert(controlRoutes.includes("'/api/service/ollama'"), 'control routes must expose ollama unload endpoint');
assert(controlRoutes.includes("'/api/mode'"), 'control routes must expose one-click mode switching');
assert(controlRoutes.includes('unloadOllamaModels') && controlRoutes.includes('keep_alive:0'), 'control routes must unload Ollama models via keep_alive=0');
assert(controlRoutes.includes('/api/ps'), 'control routes must read Ollama loaded models and VRAM usage');
assert(controlRoutes.includes('autoStartVoice'), 'voice auto-start must remain an explicit preference');
assert(controlRoutes.includes('runScriptAsync'), 'control routes must run long service scripts asynchronously');
assert(
  controlRoutes.includes('ops.begin') && controlRoutes.includes('ops.finish') && controlRoutes.includes('rejectConflict'),
  'control routes must serialize GPU operations and expose structured progress',
);
assert(
  controlRoutes.includes('refreshServiceStates'),
  'fresh status requests must wait for completed health checks instead of returning stale state',
);
// 停止只关公网分享，不牵连绘图/语音/聊天
assert(
  /stopTunnel/.test(controlRoutes) && !/stopManagedServices\s*===\s*true/.test(controlRoutes),
  'stopping the share tunnel must not implicitly stop generation services',
);
assert(controlRoutes.includes("'/api/sd-status'"), 'control routes must expose an SD status probe for the director');

// ─── 网关：公网分享不得随进程自动开启 ───
assert(
  server.includes('AUTO_TUNNEL') && server.includes('autoTunnel'),
  'gateway must not auto-open the public tunnel unless explicitly opted in',
);
// 隧道生命周期已拆到 server/tunnel.js（createTunnelManager）
const tunnelModule = read('server', 'tunnel.js');
assert(
  /tunnelStopped/.test(tunnelModule),
  'stopTunnel must latch a stopped flag so the poller cannot revive the share URL',
);

// ─── 控制面板界面：调度面板 ───
assert(controlView.includes('id="control-resources"') && controlView.includes('服务与显存调度'), 'control panel must show the VRAM scheduling panel');
assert(
  controlView.includes("switchMode('draw')") && controlView.includes("switchMode('chat')"),
  'control panel must offer draw/chat mode buttons',
);
assert(
  controlView.includes("serviceAction('webui'") && controlView.includes("serviceAction('voice'") && controlView.includes("serviceAction('ollama'"),
  'control panel must expose per-service controls',
);
assert(
  controlActions.includes('autoStartVoice') && controlActions.includes('savePreference')
    && controlApi.includes("'/api/preference'"),
  'control panel must make voice auto-start an explicit preference',
);
assert(controlView.includes('ollamaBadgeText') || controlView.includes('ollamaVram'), 'control panel must show Ollama online and VRAM status');
assert(
  controlView.includes('operation-panel') && controlView.includes('operation.stages'),
  'control panel must render operation progress and final failures',
);
assert(
  controlView.includes('公网分享'),
  'the primary stop action must describe its limited scope',
);
assert(controlView.includes('startPolling()'), 'control panel must begin health polling as soon as it opens');
assert(!/\son(click|change|input)=/.test(controlView), 'control panel must not use inline HTML event attributes');

});
