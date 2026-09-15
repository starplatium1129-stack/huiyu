'use strict';

let fs: typeof import('fs') = require('fs');
let path: typeof import('path') = require('path');
let crypto: typeof import('crypto') = require('crypto');
let runtimeTools: typeof import('../scripts/lib/runtime-paths') = require('../scripts/lib/runtime-paths');
let safeLocalUrl = (require('./security') as typeof import('./security')).safeLocalUrl;

// 上游 host 在读取时也要过一遍校验：落盘的 runtime/config.json 可能被改坏，
// 只在写入端校验会让重启成为绕过手段。
function resolveUpstreamHost(envValue: unknown, savedValue: unknown, fallback: string) {
  let candidates = [envValue, savedValue, fallback];
  for (let i = 0; i < candidates.length; i++) {
    if (!candidates[i]) continue;
    let safe = safeLocalUrl(candidates[i]);
    if (safe) return safe;
    console.warn('  ⚠ 忽略非本机上游地址:', candidates[i]);
  }
  return fallback;
}

function readJson(file: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : {};
  } catch (error) {
    return {};
  }
}

function readGatewayToken(file: string) {
  try {
    let token = fs.readFileSync(file, 'utf8').trim();
    return /^[a-f0-9]{64}$/i.test(token) ? token : '';
  } catch (error) {
    return '';
  }
}

function writeGatewayToken(file: string, token: string) {
  let temporary = file + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(temporary, token + '\n', { encoding:'utf8', mode:0o600 });
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (cleanupError) {}
    console.warn('  Unable to persist gateway token:', error instanceof Error ? error.message : String(error));
  }
}

function resolveGatewayToken(envToken: string | undefined, tokenFile: string) {
  if (envToken) return envToken;
  let savedToken = readGatewayToken(tokenFile);
  if (savedToken) return savedToken;
  let token = crypto.randomBytes(32).toString('hex');
  writeGatewayToken(tokenFile, token);
  return token;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number) {
  let number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function resolveSceneShowcaseDir(rootDir: string, configured?: unknown, workspaceRoot?: string) {
  // Accept either a published collection or its parent library folder.
  let roots = [];
  if (typeof configured === 'string' && configured.trim()) roots.push(path.resolve(configured));
  if (workspaceRoot) roots.push(path.join(workspaceRoot, 'SceneShowcase'));
  roots.push(path.resolve(rootDir, '..', 'AI', 'SceneShowcase'));
  for (const root of [...new Set(roots)]) {
    if (fs.existsSync(path.join(root, 'manifest.json'))) return root;
    try {
      let collections = fs.readdirSync(root, { withFileTypes:true })
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.')
          && fs.existsSync(path.join(root, entry.name, 'manifest.json')))
        .map(entry => path.join(root, entry.name))
        .sort((a, b) => path.basename(b).localeCompare(path.basename(a), 'zh-CN'));
      if (collections.length) return collections[0];
    } catch { /* A disconnected disk must not prevent the gateway from starting. */ }
  }
  return '';
}

/**
 * 角色参考标准图（Cinematic Bible，~1GB）——2026-08-29 随样张模式迁出项目，
 * 落 AI 工作区 CharacterReferences（与 SceneShowcase 平级），桌面安装包不再
 * 携带媒体图。env AICS_CHARACTER_REF_ROOT 显式覆盖；找不到返回 ''（前端按
 * 无参考图优雅降级，server 侧不挂 /character-references 路由）。
 */
function resolveCharRefRoot(appRoot: string, env: NodeJS.ProcessEnv, workspaceRoot?: string) {
  function isDirectory(candidate: string) {
    try { return fs.statSync(candidate).isDirectory(); } catch { return false; }
  }
  if (env.AICS_CHARACTER_REF_ROOT) {
    let explicit = path.resolve(env.AICS_CHARACTER_REF_ROOT);
    if (isDirectory(explicit)) return explicit;
    return ''; // 显式配置失效时不静默切换到另一份素材。
  }
  let bases = workspaceRoot
    ? [workspaceRoot, path.resolve(appRoot, '..', 'AI')]
    : [path.resolve(appRoot, '..', 'AI')];
  for (let i = 0; i < bases.length; i++) {
    let candidate = path.join(bases[i], 'CharacterReferences');
    if (isDirectory(candidate)) return candidate;
  }
  let legacy = path.join(path.resolve(env.AICS_ASSETS_ROOT || path.join(appRoot, 'assets')), 'character-references');
  if (isDirectory(legacy)) return legacy;
  return '';
}

function loadGatewayConfig(rootDir: string, env: NodeJS.ProcessEnv = process.env) {
  env = env || process.env;
  let appRoot = path.resolve(env.AICS_APP_ROOT || rootDir);
  let assetsRoot = path.resolve(env.AICS_ASSETS_ROOT || path.join(appRoot, 'assets'));
  let toolsRoot = path.resolve(env.AICS_TOOLS_ROOT || path.join(appRoot, 'tools'));
  let runtime = runtimeTools.createRuntimePaths(appRoot, env.AICS_RUNTIME_ROOT);
  // Fixture stacks use an isolated runtime and must not move legacy files from
  // the repository root. Production keeps the historical migration default.
  if (env.AICS_DISABLE_LEGACY_RUNTIME_MIGRATION !== '1') {
    runtimeTools.migrateLegacyRuntime(appRoot, runtime);
  }
  let saved = readJson(runtime.config);
  let translatePort = boundedInteger(env.TRANSLATE_PORT, 5310, 1024, 65535);
  let workspaceRoot = path.resolve(env.AI_WORKSPACE_ROOT || path.join(appRoot, '..', 'AI'));

  return {
    ROOT_DIR:appRoot,
    ASSETS_ROOT:assetsRoot,
    TOOLS_ROOT:toolsRoot,
    SCRIPTS_ROOT:path.resolve(env.AICS_SCRIPTS_ROOT || path.join(appRoot, 'scripts')),
    // 工作区外的 AI 资源根（LoRA 权重、语音脚本、角色参考库、样张等）。
    // 桌面打包版可落在安装目录之外；浏览器不直接提供此路径，由服务端按
    // env.AI_WORKSPACE_ROOT 或 appRoot 兄弟目录解析。
    AI_WORKSPACE_ROOT:workspaceRoot,
    // Operator environment only: request bodies and saved app settings cannot enable commands.
    DESKTOP_TRUSTED_COMMANDS:env.AICS_DESKTOP_COMMANDS === 'trusted',
    // No runtime/config.json fallback: only the operator environment selects/approves resources.
    RESOURCE_CONFIG_PATH:env.AICS_RESOURCE_CONFIG || '',
    RESOURCE_MANAGEMENT:env.AICS_RESOURCE_MANAGEMENT === 'trusted',
    RUNTIME:runtime,
    RUNTIME_ROOT:runtime.root,
    PORT:boundedInteger(env.PORT, 3000, 1, 65535),
    HOST:env.HOST || '127.0.0.1',
    // Explicit TOKEN remains an operator override. Otherwise keep one random
    // token per runtime so a shared URL survives gateway restarts.
    TOKEN:resolveGatewayToken(env.TOKEN, runtime.gatewayToken),
    TOKEN_SOURCE:env.TOKEN ? 'environment' : 'runtime/state',
    SD_HOST:resolveUpstreamHost(env.SD_HOST, saved.sdHost, 'http://127.0.0.1:7860'),
    SD_API_AUTH:env.SD_API_AUTH || '',
    COMFY_HOST:resolveUpstreamHost(env.COMFY_HOST, saved.comfyHost, 'http://127.0.0.1:8188'),
    TTS_HOST:resolveUpstreamHost(env.TTS_HOST, saved.ttsHost, 'http://127.0.0.1:9880'),
    VOICE_PROFILES:saved.voices && typeof saved.voices === 'object' && !Array.isArray(saved.voices)
      ? saved.voices as Record<string, unknown> : {},
    OLLAMA_HOST:resolveUpstreamHost(env.OLLAMA_HOST, saved.ollamaHost, 'http://127.0.0.1:11434'),
    OLLAMA_MODEL:env.OLLAMA_MODEL || (typeof saved.ollamaModel === 'string' ? saved.ollamaModel : ''),
    OLLAMA_KEEP_ALIVE:env.OLLAMA_KEEP_ALIVE || '10m',
    OLLAMA_NUM_PREDICT:boundedInteger(env.OLLAMA_NUM_PREDICT, 300, 32, 2048),
    OLLAMA_NUM_CTX:boundedInteger(env.OLLAMA_NUM_CTX, 4096, 1024, 32768),
    TRANSLATION_PYTHON:env.TRANSLATION_PYTHON || path.resolve(workspaceRoot, 'GPT-SoVITS-env', 'python.exe'),
    TRANSLATION_SCRIPT:path.join(toolsRoot, 'translate-zh-ja.py'),
    TRANSLATE_PORT:translatePort,
    TRANSLATE_URL:'http://127.0.0.1:' + translatePort,
    TRANSLATION_LOG:path.join(runtime.logs, 'translate.log'),
    // 控制面板服务自愈的探测间隔；此前 control.js 读这个字段但 config 从未定义，
    // 恒为默认 5000ms。这里补上 env 解析，让配置真正生效。
    SELF_HEALING_INTERVAL_MS:boundedInteger(env.SELF_HEALING_INTERVAL_MS, 5000, 1000, 60000),
    LIVE2D_ROOT:path.join(assetsRoot, 'live2d'),
    SCENE_SHOWCASE_DIR:resolveSceneShowcaseDir(appRoot, env.SCENE_SHOWCASE_DIR || saved.sceneShowcaseDir, workspaceRoot),
    CHARACTER_REF_ROOT:resolveCharRefRoot(appRoot, env, workspaceRoot),
    CHARACTER_REF_EXPLICIT_ROOT:env.AICS_CHARACTER_REF_ROOT ? path.resolve(env.AICS_CHARACTER_REF_ROOT) : '',
    DISABLE_TUNNEL:env.DISABLE_TUNNEL === '1',
    // 桌面打包模式（Tauri 壳仅在打包模式注入，见 main_shared.rs gateway_env）：
    // 场景内容维护链路（scenes/run/build-web）返回 501，展示类不受限。
    DESKTOP_PACKAGED:env.AICS_DESKTOP_PACKAGED === '1',
    CLOUDFLARED_PATH:env.CLOUDFLARED_PATH || 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe'
  };
}

export = {
  loadGatewayConfig:loadGatewayConfig,
  resolveSceneShowcaseDir:resolveSceneShowcaseDir,
  resolveCharRefRoot:resolveCharRefRoot,
  boundedInteger:boundedInteger,
  resolveGatewayToken:resolveGatewayToken
};
