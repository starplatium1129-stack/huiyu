'use strict';
/**
 * scripts/tests/mock-stack.js
 *
 * 启动「四个假上游 + 一个真网关」，供 tests/e2e/flows.spec.ts 使用。
 * 由 playwright.config.ts 的第二个 webServer 拉起；也可以手动跑：
 *
 *   node scripts/tests/mock-stack.js
 *
 * 设计约束：
 *  1. 网关是真的 —— createGateway 的中间件栈、SD 代理白名单、NDJSON 中继、
 *     音频背压中继全部参与。只有上游被替换。
 *  2. runtime 目录必须隔离。控制面板路由会往 RUNTIME.config 落盘（autoTunnel、
 *     voices、上游 host），跑一次 E2E 不该改用户真实的 runtime/config.json。
 *  3. 声线 profile 直接注入。tts-service 只检查 refAudioPath / promptText 是否
 *     存在（不 stat 文件），所以假路径足够让 /api/tts-status 报 voices.nene=true。
 */

let fs: typeof import('fs') = require('fs');
let os: typeof import('os') = require('os');
let path: typeof import('path') = require('path');
let createGateway = require(path.join(__dirname, '..', '..', 'server.js')).createGateway;
let loadGatewayConfig = require(path.join(__dirname, '..', '..', 'server', 'config.js')).loadGatewayConfig;
let runtimePaths = require(path.join(__dirname, '..', 'lib', 'runtime-paths.js'));
let mocks: typeof import('./mock-upstreams') = require('./mock-upstreams');

let PORTS: typeof import('../lib/e2e-ports') = require('../lib/e2e-ports');
let COMFY_PORT = Number(process.env.AICS_MOCK_COMFY_PORT || PORTS.comfy || (PORTS.translate + 1));
let ROOT_DIR = path.join(__dirname, '..', '..');
let TOKEN = 'mock-stack-token-0123456789abcdef0123';

function isolatedRuntime() {
  let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-e2e-runtime-'));
  return runtimePaths.createRuntimePaths(dir);
}

function buildConfig(runtime: { root: string; logs: string; }) {
  let config = loadGatewayConfig(ROOT_DIR, {
    AICS_RUNTIME_ROOT:runtime.root,
    AI_WORKSPACE_ROOT:path.join(runtime.root, 'AI workspace'),
    AICS_DISABLE_LEGACY_RUNTIME_MIGRATION:'1',
    PORT:String(PORTS.gateway),
    HOST:'127.0.0.1',
    TOKEN:TOKEN,
    DISABLE_TUNNEL:'1',
    SD_HOST:'http://127.0.0.1:' + PORTS.sd,
    COMFY_HOST:'http://127.0.0.1:' + COMFY_PORT,
    TTS_HOST:'http://127.0.0.1:' + PORTS.tts,
    OLLAMA_HOST:'http://127.0.0.1:' + PORTS.ollama,
    TRANSLATE_PORT:String(PORTS.translate)
  });

  // runtime 换到临时目录：控制面板写盘不得污染真实 runtime/
  config.RUNTIME = runtime;
  config.RUNTIME_ROOT = runtime.root;
  config.TRANSLATION_LOG = path.join(runtime.logs, 'translate.log');

  // 声线 profile：让 /api/tts-status 报两个角色都已配置
  config.VOICE_PROFILES = {
    nene:{
      refAudioPath:'D:/mock/nene/neutral.wav',
      promptText:'ねえ、ちょっと聞いてもいい？',
      promptLang:'ja',
      gptWeightsPath:'D:/mock/nene/gpt.ckpt',
      sovitsWeightsPath:'D:/mock/nene/sovits.pth',
      references:{
        gentle:{ refAudioPath:'D:/mock/nene/gentle.wav', promptText:'大丈夫だよ。', promptLang:'ja' }
      }
    },
    natsume:{
      refAudioPath:'D:/mock/natsume/neutral.wav',
      promptText:'まったく、無理しないで。',
      promptLang:'ja',
      gptWeightsPath:'D:/mock/natsume/gpt.ckpt',
      sovitsWeightsPath:'D:/mock/natsume/sovits.pth'
    }
  };

  // 翻译常驻服务已由 mock 顶替，禁掉 legacy spawn 回退：
  // 指向不存在的路径，translation-service 会直接拒绝而不是拉起 python.exe
  config.TRANSLATION_PYTHON = path.join(runtime.root, 'no-such-python.exe');
  config.TRANSLATION_SCRIPT = path.join(runtime.root, 'no-such-script.py');
  let previewLoraRoot = path.join(config.AI_WORKSPACE_ROOT, 'ComfyUI', 'models', 'loras');
  fs.mkdirSync(previewLoraRoot, { recursive:true });
  fs.writeFileSync(path.join(previewLoraRoot, 'ayachi_nene_v21_anima.safetensors'), 'e2e-nene-v21-fixture');
  fs.writeFileSync(path.join(previewLoraRoot, 'shiki_natsume_v21_anima.safetensors'), 'e2e-natsume-v21-fixture');
  // Anima 无 LoRA 底模资源：让 /api/anima/status 报 anima-aesthetic 可用（engineOnline 依赖 available）。
  let animaModelRoot = path.join(config.AI_WORKSPACE_ROOT, 'ComfyUI', 'models');
  fs.mkdirSync(path.join(animaModelRoot, 'diffusion_models'), { recursive:true });
  fs.mkdirSync(path.join(animaModelRoot, 'text_encoders'), { recursive:true });
  fs.mkdirSync(path.join(animaModelRoot, 'vae'), { recursive:true });
  fs.writeFileSync(path.join(animaModelRoot, 'diffusion_models', 'anima-aesthetic-v1.1.safetensors'), 'e2e-anima-fixture');
  fs.writeFileSync(path.join(animaModelRoot, 'diffusion_models', 'Anima-2.9B-preview-v1.safetensors'), 'e2e-anima-fixture');
  fs.writeFileSync(path.join(animaModelRoot, 'diffusion_models', 'anima-base-v1.0.safetensors'), 'e2e-anima-fixture');
  fs.writeFileSync(path.join(animaModelRoot, 'diffusion_models', 'AnimaYume_v10_final_base.safetensors'), 'e2e-anima-fixture');
  fs.writeFileSync(path.join(animaModelRoot, 'diffusion_models', 'miaomiaoHarem_anima12.safetensors'), 'e2e-anima-fixture');
  fs.writeFileSync(path.join(animaModelRoot, 'diffusion_models', 'krea2_turbo_fp8_scaled.safetensors'), 'e2e-krea-fixture');
  fs.writeFileSync(path.join(animaModelRoot, 'text_encoders', 'qwen_3_06b_base.safetensors'), 'e2e-anima-fixture');
  fs.writeFileSync(path.join(animaModelRoot, 'text_encoders', 'qwen3-vl-4b-heretic_fp8_e4m3fn.safetensors'), 'e2e-krea-fixture');
  fs.writeFileSync(path.join(animaModelRoot, 'vae', 'qwen_image_vae.safetensors'), 'e2e-anima-fixture');
  return config;
}

async function start() {
  let runtime = isolatedRuntime();
  let upstreams = [
    { name:'sd', port:PORTS.sd, mock:mocks.createSdMock() },
    { name:'comfy', port:COMFY_PORT, mock:mocks.createComfyMock() },
    { name:'ollama', port:PORTS.ollama, mock:mocks.createOllamaMock() },
    { name:'tts', port:PORTS.tts, mock:mocks.createTtsMock() },
    { name:'translate', port:PORTS.translate, mock:mocks.createTranslateMock() }
  ];

  for (let i = 0; i < upstreams.length; i += 1) {
    await mocks.listen(upstreams[i].mock.server, upstreams[i].port);
    console.log('  🧪 mock ' + upstreams[i].name + ' → http://127.0.0.1:' + upstreams[i].port);
  }

  let config = buildConfig(runtime);
  let gateway = createGateway({ config:config });
  let server = gateway.app.listen(config.PORT, config.HOST, function () {
    console.log('  🔗 mock gateway → http://127.0.0.1:' + config.PORT);
    console.log('  🗂 isolated runtime → ' + runtime.root);
  });
  server.on('upgrade', gateway.handleUpgrade);

  // 未捕获异常不该静默带走整个 mock 栈
  process.on('unhandledRejection', function (reason: any) {
    console.error('  ❌ mock stack unhandled rejection:', reason && reason.stack || reason);
  });

  function shutdown() {
    try { gateway.close(); } catch (error) {}
    upstreams.forEach(function (item) { try { item.mock.server.close(); } catch (error) {} });
    server.close(function () { process.exit(0); });
    setTimeout(function () { process.exit(0); }, 2000).unref();
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return { gateway:gateway, server:server, upstreams:upstreams, config:config, shutdown:shutdown };
}

if (require.main === module) {
  start().catch(function (error) {
    console.error('mock stack failed to start:', error);
    process.exit(1);
  });
}

export = { start:start, PORTS:PORTS, COMFY_PORT:COMFY_PORT, TOKEN:TOKEN };
