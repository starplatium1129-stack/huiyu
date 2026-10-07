'use strict';
/** Real Rust gateway with isolated application/state roots. Node supplies only
 * programmable HTTP upstream fixtures; neither mode loads createGateway. */
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
const mocks: typeof import('./mock-upstreams') = require('./mock-upstreams');
const { killProcessTree }: typeof import('../lib/process-tree') = require('../lib/process-tree');
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
    diffusion_models: ['anima-aesthetic-v1.1.safetensors', 'miaomiaoHarem_29BBETA11.safetensors', 'anima-base-v1.0.safetensors',
      'AnimaYume_v10_final_base.safetensors', 'miaomiaoHarem_anima12.safetensors', 'miaomiaoHarem_anima16.safetensors', 'krea2_turbo_fp8_scaled.safetensors'],
    text_encoders: ['qwen_3_06b_base.safetensors', 'qwen3-vl-4b-heretic_fp8_e4m3fn.safetensors'],
    vae: ['qwen_image_vae.safetensors']
  };
  for (const [group, names] of Object.entries(groups)) {
    const directory = path.join(models, group); fs.mkdirSync(directory, { recursive: true });
    for (const name of names) fs.writeFileSync(path.join(directory, name), 'neutral mock model catalog entry; not model weights');
  }
}

function prepare(webOnly: boolean, workspace: boolean, lightweight: boolean) {
  const selected = process.env.AICS_RUST_RUNTIME_EXE || path.join(ROOT_DIR, 'runtime-rs/target/release', process.platform === 'win32' ? 'huiyu-runtime.exe' : 'huiyu-runtime');
  if (!path.isAbsolute(selected) || !fs.statSync(selected, { throwIfNoEntry: false })?.isFile()) {
    throw Error('Build the Rust browser backend first: npm run wf -- rust:build');
  }
  if (!lightweight && !fs.existsSync(path.join(ROOT_DIR, 'dist/index.html'))) throw Error('Build the SPA first: npm run build');
  // Windows TEMP can use an 8.3 alias; Rust requires its native canonical root.
  const temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX)));
  const application = path.join(temporary, 'app'), runtime = path.join(temporary, 'runtime'), ai = path.join(temporary, 'AI');
  try {
    fs.mkdirSync(application);
    // Data writes stay in the disposable app; model/runtime roots are isolated below.
    // Large immutable images are served from the explicit read-only asset root.
    for (const name of (lightweight ? ['data'] : ['dist', 'data', 'docs', 'css'])) {
      const source = path.join(ROOT_DIR, name);
      if (fs.existsSync(source)) fs.cpSync(source, path.join(application, name), { recursive: true });
    }
    if (lightweight) { fs.mkdirSync(path.join(application, 'dist')); fs.writeFileSync(path.join(application, 'dist/index.html'), '<!doctype html><title>Rust HTTP fixture</title>'); }
    fs.mkdirSync(path.join(application, 'src/assets'), { recursive: true });
    fs.cpSync(path.join(ROOT_DIR, 'src/assets/css'), path.join(application, 'src/assets/css'), { recursive: true });
    fs.mkdirSync(runtime); fs.mkdirSync(ai);
    const references = path.join(temporary, 'references'), showcase = path.join(temporary, 'showcase');
    fs.mkdirSync(references); fs.mkdirSync(showcase);
    fs.writeFileSync(path.join(showcase, 'manifest.json'), JSON.stringify({ version: 1, entries: [] }));
    if (!webOnly) fixtureModels(ai);
    fs.writeFileSync(path.join(runtime, 'config.json'), JSON.stringify({ autoTunnel: false, voices: webOnly ? {} : VOICES }));
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'ProgramFiles', 'ProgramFiles(x86)', 'COMSPEC', 'LANG', 'LC_ALL', 'AICS_VIPS_DYLIB_PATH']) {
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
      TRANSLATE_PORT: String(PORTS.translate), TRANSLATION_PYTHON: path.join(temporary, 'no-model-python.exe')
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
    const secret = randomBytes(32).toString('hex'), workspaceId = randomUUID(), sourceProfileId = `profile-${'a'.repeat(64)}`;
    if (workspace) Object.assign(env, { AICS_DESKTOP_GATEWAY_TOKEN: secret, AICS_DESKTOP_SOURCE_PROFILE_ID: sourceProfileId });
    const executable = path.join(temporary, path.basename(selected)); fs.copyFileSync(selected, executable);
    if (process.platform !== 'win32') fs.chmodSync(executable, 0o755);
    return { temporary, application, runtime, ai, executable, env, secret, workspaceId, sourceProfileId, port: webOnly ? PORTS.web : PORTS.gateway };
  } catch (error) { cleanup(temporary); throw error; }
}
function cleanup(directory: string) {
  const root = fs.realpathSync.native(os.tmpdir()), target = fs.realpathSync.native(directory), relative = path.relative(root, target);
  if (!relative || path.isAbsolute(relative) || relative.includes(path.sep) || !relative.startsWith(TEMP_PREFIX)) {
    throw Error('Refusing cleanup outside the exact temporary fixture root');
  }
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
function waitReady(child: ChildProcess, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let pending = '', settled = false, origin = '';
    const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timeout); child.removeListener('error', failed); child.removeListener('exit', exited); error ? reject(error) : resolve(origin); };
    const failed = (error: Error) => finish(error), exited = (code: number | null) => finish(Error(`Rust fixture exited before ready (${code})`));
    const timeout = setTimeout(() => finish(Error('Rust fixture did not become ready')), 45_000);
    child.once('error', failed); child.once('exit', exited);
    child.stderr?.on('data', chunk => process.stderr.write(chunk));
    child.stdout?.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk); pending += chunk.toString('utf8');
      let newline: number;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        try { const value = JSON.parse(line); if (value.event === 'ready' && value.runtime === 'rust' && (port === 0 ? /^http:\/\/127\.0\.0\.1:\d+$/.test(value.origin) : value.origin === `http://127.0.0.1:${port}`)) { origin = value.origin; finish(); } } catch {}
      }
      if (pending.length > 64 * 1024) pending = pending.slice(-64 * 1024);
    });
  });
}
interface Options { webOnly?: boolean; dynamicPorts?: boolean; workspace?: boolean; lightweight?: boolean; prepare?: (fixture: { application: string; runtime: string; ai: string; env: NodeJS.ProcessEnv }) => void | Promise<void> }
async function start({ webOnly = false, dynamicPorts = false, workspace = false, lightweight = false, prepare: customize }: Options = {}) {
  const prepared = prepare(webOnly, workspace, lightweight);
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
      const address = await mocks.listen(upstream.mock.server, dynamicPorts ? 0 : upstream.port) as import('node:net').AddressInfo;
      upstream.port = address.port;
      const key = ({ sd: 'SD_HOST', comfy: 'COMFY_HOST', ollama: 'OLLAMA_HOST', tts: 'TTS_HOST', translate: 'TRANSLATE_PORT' } as Record<string, string>)[upstream.name];
      prepared.env[key] = upstream.name === 'translate' ? String(address.port) : `http://127.0.0.1:${address.port}`;
      console.log(`mock ${upstream.name}: http://127.0.0.1:${upstream.port}`);
    }
    await customize?.(prepared);
    const args = ['--app-root', prepared.application, '--bind', `127.0.0.1:${dynamicPorts ? 0 : prepared.port}`];
    if (workspace) args.push('--workspace-root', path.join(prepared.temporary, 'workspace'), '--workspace-id', prepared.workspaceId, '--create-workspace');
    child = spawn(prepared.executable, args,
      { cwd: prepared.application, env: prepared.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const origin = await waitReady(child, dynamicPorts ? 0 : prepared.port);
    child.once('close', () => { if (!stopped) { process.exitCode = 1; stop(); } });
    console.log(`isolated Rust ${webOnly ? 'web' : 'mock'} runtime: ${prepared.runtime}`);
    const session = async (windowId = 'atelier') => {
      if (!workspace) throw Error('Fixture did not request a workspace');
      const body = JSON.stringify({ action: 'session', timestamp: Date.now(), nonce: randomBytes(32).toString('hex'), windowId, sourceProfileId: prepared.sourceProfileId, origin });
      const proof = createHmac('sha256', prepared.secret).update(`aics-desktop-host:v1\n${body}`).digest('hex');
      const response = await fetch(origin + '/api/desktop-host', { method: 'POST', headers: { 'content-type': 'application/json', 'x-aics-host-proof': proof }, body, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw Error(`Rust session failed ${response.status}: ${await response.text()}`);
      return response.json();
    };
    return { child, upstreams, origin, application: prepared.application, runtime: prepared.runtime, sourceProfileId: prepared.sourceProfileId, workspaceId: prepared.workspaceId, session, shutdown };
  } catch (error) { await shutdown(); throw error; }
}
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--web-only') || args.length > 1) { console.error('mock-stack [--web-only]'); process.exitCode = 2; }
  else start({ webOnly: args.includes('--web-only') }).catch(error => { console.error('Rust browser fixture startup failed:', error); process.exitCode = 1; });
}
export = { start, PORTS, COMFY_PORT, TOKEN };
