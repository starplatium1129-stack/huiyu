'use strict';
/** Real Rust gateway with isolated application/state roots. Node supplies only
 * programmable HTTP upstream fixtures; neither mode loads createGateway. */
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
const mocks: typeof import('./mock-upstreams') = require('./mock-upstreams');
const { killProcessTree }: typeof import('../../server/process-tree') = require('../../server/process-tree');
const { developmentNativeEnvironment }: typeof import('../maintenance/desktop-rust-inputs') = require('../maintenance/desktop-rust-inputs');
const PORTS: typeof import('../lib/e2e-ports') = require('../lib/e2e-ports');
const COMFY_PORT = Number(process.env.AICS_MOCK_COMFY_PORT || PORTS.comfy || (PORTS.translate + 1));
const ROOT_DIR = path.resolve(__dirname, '../..');
const TOKEN = 'mock-stack-token-0123456789abcdef0123';
const TEMP_PREFIX = 'aics-rust-e2e-';

const VOICES = {
  nene: {
    refAudioPath: 'D:/mock/nene/neutral.wav', promptText: 'ねえ、ちょっと聞いてもいい？', promptLang: 'ja',
    gptWeightsPath: 'D:/mock/nene/gpt.ckpt', sovitsWeightsPath: 'D:/mock/nene/sovits.pth',
    references: { gentle: { refAudioPath: 'D:/mock/nene/gentle.wav', promptText: '大丈夫だよ。', promptLang: 'ja' } }
  },
  natsume: {
    refAudioPath: 'D:/mock/natsume/neutral.wav', promptText: 'まったく、無理しないで。', promptLang: 'ja',
    gptWeightsPath: 'D:/mock/natsume/gpt.ckpt', sovitsWeightsPath: 'D:/mock/natsume/sovits.pth'
  }
};

function fixtureModels(ai: string) {
  const models = path.join(ai, 'ComfyUI/models');
  const groups = {
    loras: ['ayachi_nene_v21_anima.safetensors', 'shiki_natsume_v21_anima.safetensors'],
    diffusion_models: ['anima-aesthetic-v1.1.safetensors', 'Anima-2.9B-preview-v1.safetensors', 'anima-base-v1.0.safetensors',
      'AnimaYume_v10_final_base.safetensors', 'miaomiaoHarem_anima12.safetensors', 'krea2_turbo_fp8_scaled.safetensors'],
    text_encoders: ['qwen_3_06b_base.safetensors', 'qwen3-vl-4b-heretic_fp8_e4m3fn.safetensors'],
    vae: ['qwen_image_vae.safetensors']
  };
  for (const [group, names] of Object.entries(groups)) {
    const directory = path.join(models, group); fs.mkdirSync(directory, { recursive: true });
    for (const name of names) fs.writeFileSync(path.join(directory, name), 'neutral mock model catalog entry; not model weights');
  }
}

function prepare(webOnly: boolean) {
  const selected = process.env.AICS_RUST_RUNTIME_EXE || path.join(ROOT_DIR, 'runtime-rs/target/release', process.platform === 'win32' ? 'huiyu-runtime.exe' : 'huiyu-runtime');
  if (!path.isAbsolute(selected) || !fs.statSync(selected, { throwIfNoEntry: false })?.isFile()) {
    throw Error('Build the Rust browser backend first: npm run wf -- rust:build');
  }
  if (!fs.existsSync(path.join(ROOT_DIR, 'dist/index.html'))) throw Error('Build the SPA first: npm run build');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  const application = path.join(temporary, 'app'), runtime = path.join(temporary, 'runtime'), ai = path.join(temporary, 'AI');
  try {
    fs.mkdirSync(application);
    // Data writes and legacy WD14 fallback paths stay in the disposable app.
    // Large immutable images are served from the explicit read-only asset root.
    for (const name of ['dist', 'data', 'docs', 'css']) {
      const source = path.join(ROOT_DIR, name);
      if (fs.existsSync(source)) fs.cpSync(source, path.join(application, name), { recursive: true });
    }
    fs.mkdirSync(path.join(application, 'src/assets'), { recursive: true });
    fs.cpSync(path.join(ROOT_DIR, 'src/assets/css'), path.join(application, 'src/assets/css'), { recursive: true });
    fs.mkdirSync(runtime); fs.mkdirSync(ai);
    const references = path.join(temporary, 'references'), showcase = path.join(temporary, 'showcase');
    fs.mkdirSync(references); fs.mkdirSync(showcase);
    fs.writeFileSync(path.join(showcase, 'manifest.json'), JSON.stringify({ version: 1, entries: [] }));
    if (!webOnly) fixtureModels(ai);
    fs.writeFileSync(path.join(runtime, 'config.json'), JSON.stringify({ autoTunnel: false, voices: webOnly ? {} : VOICES }));
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'ProgramFiles', 'ProgramFiles(x86)', 'COMSPEC', 'LANG', 'LC_ALL']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    Object.assign(env, {
      AICS_APP_ROOT: application, AICS_RUNTIME_ROOT: runtime, AI_WORKSPACE_ROOT: ai,
      AICS_ASSETS_ROOT: path.join(ROOT_DIR, 'assets'), AICS_TOOLS_ROOT: path.join(ROOT_DIR, 'tools'),
      AICS_CHARACTER_REF_ROOT: references, SCENE_SHOWCASE_DIR: showcase, AICS_DISABLE_LEGACY_RUNTIME_MIGRATION: '1',
      AICS_DESKTOP_COMMANDS: 'disabled', DISABLE_TUNNEL: '1', TOKEN,
      HOME: path.join(temporary, 'user'), USERPROFILE: path.join(temporary, 'user'),
      APPDATA: path.join(temporary, 'user/AppData/Roaming'), LOCALAPPDATA: path.join(temporary, 'user/AppData/Local'),
      SD_HOST: `http://127.0.0.1:${PORTS.sd}`, COMFY_HOST: `http://127.0.0.1:${COMFY_PORT}`,
      OLLAMA_HOST: `http://127.0.0.1:${PORTS.ollama}`, TTS_HOST: `http://127.0.0.1:${PORTS.tts}`,
      TRANSLATE_PORT: String(PORTS.translate), TRANSLATION_PYTHON: path.join(temporary, 'no-model-python.exe'),
      AICS_WD14_MODEL_DIR: path.join(temporary, 'no-wd14-model')
    });
    if (process.platform === 'win32') Object.assign(env, developmentNativeEnvironment(ROOT_DIR, env));
    else {
      // Test-launcher selection only. Production loads its explicit/bundled DLL,
      // never an npm directory. The optional package is pinned by package-lock.
      const native = path.join(ROOT_DIR, 'node_modules/@img', `sharp-libvips-${process.platform}-${process.arch}`, 'lib');
      const name = fs.existsSync(native) ? fs.readdirSync(native).find(file => /^libvips.*\.(?:so(?:\.\d+)*|dylib)$/.test(file)) : undefined;
      if (!name) throw Error(`No locked native image fixture library in ${native}`);
      env.AICS_VIPS_DYLIB_PATH = fs.realpathSync(path.join(native, name));
    }
    // A real WD14 library or model is never admitted by ordinary browser tests.
    env.AICS_ORT_DYLIB_PATH = path.join(temporary, 'no-model-onnxruntime.dll');
    const executable = path.join(temporary, path.basename(selected)); fs.copyFileSync(selected, executable);
    if (process.platform !== 'win32') fs.chmodSync(executable, 0o755);
    return { temporary, application, runtime, ai, executable, env, port: webOnly ? PORTS.web : PORTS.gateway };
  } catch (error) { cleanup(temporary); throw error; }
}
function cleanup(directory: string) {
  const root = fs.realpathSync(os.tmpdir()), target = fs.realpathSync(directory), relative = path.relative(root, target);
  if (!relative || path.isAbsolute(relative) || relative.includes(path.sep) || !relative.startsWith(TEMP_PREFIX)) {
    throw Error('Refusing cleanup outside the exact temporary fixture root');
  }
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
function waitReady(child: ChildProcess, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let pending = '', settled = false;
    const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timeout); child.removeListener('error', failed); child.removeListener('exit', exited); error ? reject(error) : resolve(); };
    const failed = (error: Error) => finish(error), exited = (code: number | null) => finish(Error(`Rust fixture exited before ready (${code})`));
    const timeout = setTimeout(() => finish(Error('Rust fixture did not become ready')), 45_000);
    child.once('error', failed); child.once('exit', exited);
    child.stderr?.on('data', chunk => process.stderr.write(chunk));
    child.stdout?.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk); pending += chunk.toString('utf8');
      let newline: number;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        try { const value = JSON.parse(line); if (value.event === 'ready' && value.runtime === 'rust' && value.origin === `http://127.0.0.1:${port}`) finish(); } catch {}
      }
      if (pending.length > 64 * 1024) pending = pending.slice(-64 * 1024);
    });
  });
}
async function start({ webOnly = false }: { webOnly?: boolean } = {}) {
  const prepared = prepare(webOnly);
  const upstreams = webOnly ? [] : [
    { name: 'sd', port: PORTS.sd, mock: mocks.createSdMock() },
    { name: 'comfy', port: COMFY_PORT, mock: mocks.createComfyMock() },
    { name: 'ollama', port: PORTS.ollama, mock: mocks.createOllamaMock() },
    { name: 'tts', port: PORTS.tts, mock: mocks.createTtsMock() },
    { name: 'translate', port: PORTS.translate, mock: mocks.createTranslateMock() }
  ];
  let child: ChildProcess | undefined, stopped: Promise<void> | undefined;
  const shutdown = () => stopped ||= (async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'close').catch(() => []);
      child.kill('SIGINT');
      const force = setTimeout(() => { if (child && child.exitCode === null && child.signalCode === null) killProcessTree(child); }, 3000);
      await exited; clearTimeout(force);
    }
    await Promise.all(upstreams.map(({ mock }) => new Promise<void>(resolve => {
      mock.server.closeAllConnections(); mock.server.close(() => resolve());
    })));
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    cleanup(prepared.temporary);
  })();
  const stop = () => { void shutdown().catch(error => { console.error(error); process.exitCode = 1; }); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    for (const upstream of upstreams) {
      await mocks.listen(upstream.mock.server, upstream.port);
      console.log(`mock ${upstream.name}: http://127.0.0.1:${upstream.port}`);
    }
    child = spawn(prepared.executable, ['--app-root', prepared.application, '--bind', `127.0.0.1:${prepared.port}`],
      { cwd: prepared.application, env: prepared.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    await waitReady(child, prepared.port);
    child.once('close', () => { if (!stopped) { process.exitCode = 1; stop(); } });
    console.log(`isolated Rust ${webOnly ? 'web' : 'mock'} runtime: ${prepared.runtime}`);
    return { child, upstreams, runtime: prepared.runtime, shutdown };
  } catch (error) { await shutdown(); throw error; }
}
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--web-only') || args.length > 1) { console.error('mock-stack [--web-only]'); process.exitCode = 2; }
  else start({ webOnly: args.includes('--web-only') }).catch(error => { console.error('Rust browser fixture startup failed:', error); process.exitCode = 1; });
}
export = { start, PORTS, COMFY_PORT, TOKEN };
