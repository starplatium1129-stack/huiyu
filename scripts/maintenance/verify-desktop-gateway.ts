'use strict';
// Execute the staged Rust payload outside the source tree with isolated state.
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import net = require('node:net');
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const { killProcessTree }: typeof import('../lib/process-tree') = require('../lib/process-tree');
import safe = require('../lib/delivery-paths');
import { loadNativeLicenseMaterials, NATIVE_MANIFEST, readNativeMaterialFromWorktree, verifyNativeLicenseMaterial } from '../lib/native-license-materials';
const {copyDir}:typeof import('./desktop-stage-resources')=require('./desktop-stage-resources');
const ROOT = path.resolve(__dirname, '../..');
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as net.AddressInfo).port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
function isolatedEnvironment(temporary: string, gateway: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'ProgramFiles', 'ProgramFiles(x86)', 'COMSPEC']) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, { DISABLE_TUNNEL: '1', SD_HOST: 'http://127.0.0.1:1', COMFY_HOST: 'http://127.0.0.1:1',
    TTS_HOST: 'http://127.0.0.1:1', OLLAMA_HOST: 'http://127.0.0.1:1', TRANSLATE_PORT: '1',
    AICS_APP_ROOT: gateway, AICS_RUNTIME_ROOT: path.join(temporary, 'state'), AI_WORKSPACE_ROOT: path.join(temporary, 'AI'),
    AICS_DESKTOP_PACKAGED: '1', AICS_DISABLE_LEGACY_RUNTIME_MIGRATION: '1', USERPROFILE: path.join(temporary, 'user'),
    APPDATA: path.join(temporary, 'user/AppData/Roaming'), LOCALAPPDATA: path.join(temporary, 'user/AppData/Local'),
    TRANSLATION_PYTHON: path.join(temporary, 'no-model-python.exe') });
  return env;
}
async function verifyDesktopGateway({ root = ROOT, logger = console.log }: { root?: string; logger?: (text: string) => void } = {}) {
  const tauri = path.join(root, 'desktop-tauri/src-tauri'), config = JSON.parse(fs.readFileSync(path.join(tauri, 'tauri.conf.json'), 'utf8'));
  if (config.bundle.externalBin?.length) throw Error('Rust bundle must not ship interpreter sidecars');
  const temporary = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'huiyu-installed-rust-'));
  let child: ReturnType<typeof spawn> | undefined, exited: Promise<unknown> | undefined, output = '';
  try {
    for (const [source, destination] of Object.entries(config.bundle.resources)) {
      const target = path.resolve(temporary, String(destination));
      if (!target.startsWith(temporary + path.sep)) throw Error('Bundle destination escapes installation');
      const input=safe.resolveSafe(tauri,source);
      if(fs.statSync(input).isDirectory()) copyDir(input,target);
      else {fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(input,target);}
    }
    const gateway = path.join(temporary, 'gateway'), binary = path.join(gateway, 'huiyu-runtime.exe');
    for (const forbidden of ['node_modules', 'server.js', 'server', 'routes', 'services', 'package.json']) if (fs.existsSync(path.join(gateway, forbidden))) throw Error(`Legacy runtime unexpectedly bundled: ${forbidden}`);
    const bound = JSON.parse(fs.readFileSync(path.join(gateway, 'rust-runtime-build.json'), 'utf8'));
    const { createHash } = require('node:crypto') as typeof import('node:crypto');
    if (createHash('sha256').update(fs.readFileSync(binary)).digest('hex') !== bound.runtime.sha256) throw Error('Installed Rust executable differs from build binding');
    const nativeBytes=fs.readFileSync(path.join(gateway,'native-dependencies.windows-x64.json'));
    if(createHash('sha256').update(nativeBytes).digest('hex')!==bound.nativeManifestSha256)throw Error('Installed native manifest differs from binding');
    const native=JSON.parse(nativeBytes.toString('utf8'));
    const {checkedBytes}:typeof import('./desktop-rust-inputs')=require('./desktop-rust-inputs');
    for(const file of native.files)checkedBytes(gateway,`native/${file.name}`,file);
    const staged = readNativeMaterialFromWorktree(gateway);
    const readMaterial = (file:string) => file === NATIVE_MANIFEST ? nativeBytes : staged(file.slice('runtime-rs/'.length));
    const materials = loadNativeLicenseMaterials(readMaterial);
    if (materials.size !== bound.nativeMaterialCount) throw Error('Installed native material inventory differs from binding');
    for (const [file] of materials) verifyNativeLicenseMaterial(materials,file,readMaterial(file));
    const port = await freePort(), base = `http://127.0.0.1:${port}`, started = Date.now();
    child = spawn(binary, ['--app-root', gateway, '--bind', `127.0.0.1:${port}`], { cwd: gateway, env: isolatedEnvironment(temporary, gateway), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    exited = once(child, 'close'); exited.catch(() => {});
    child.stdout!.on('data', data => { output = (output + data).slice(-16000); }); child.stderr!.on('data', data => { output = (output + data).slice(-16000); });
    let startupError: Error | undefined; child.on('error', error => { startupError = error; });
    for (;;) {
      if (startupError) throw startupError;
      if (child.exitCode !== null) throw Error(`Packaged Rust runtime exited: ${output}`);
      try { const response = await fetch(base + '/api/health', { signal: AbortSignal.timeout(1500) }); const health: any = await response.json();
        if (response.ok && health.ok && health.app === 'ai-cg-studio' && health.gateway && health.port === port) break;
      } catch { /* Bounded readiness polling; no requests to model endpoints. */ }
      if (Date.now() - started > 20000) throw Error(`Packaged Rust runtime readiness timed out: ${output}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const readyMs = Date.now() - started;
    for (const route of ['/', '/gallery', '/companion', '/companion-chat', '/docs/INDEX.md']) {
      const response = await fetch(base + route, { signal: AbortSignal.timeout(5000) });
      if (!response.ok || !(await response.text()).length) throw Error(`Packaged route ${route}: HTTP ${response.status}`);
    }
    const redirects = JSON.parse(fs.readFileSync(path.join(gateway, 'docs/redirects.json'), 'utf8'));
    const redirect = Object.entries(redirects)[0]; if (!redirect) throw Error('Documentation redirect inventory is empty');
    const [from, to] = redirect, response = await fetch(base + from, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    if (response.status !== 308 || response.headers.get('location') !== to) throw Error('Packaged documentation redirect failed');
    logger(`[desktop:verify-gateway] PASS: Rust isolated bundle ready in ${readyMs}ms; four pages and documentation available; releaseReady=${bound.releaseReady}`);
    return { readyMs, runtimeSha256: bound.runtime.sha256, releaseReady: bound.releaseReady, pending: bound.pending };
  } finally {
    if (child?.pid && child.exitCode === null) killProcessTree(child);
    if (exited) await Promise.race([exited.catch(() => {}), new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('Owned verifier process did not exit')), 8000); timer.unref(); })]);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
if (require.main === module) {
  if (process.argv.includes('--help')) console.log('Verify the staged Rust gateway in an isolated temporary installation; no models, tunnels or installation.');
  else verifyDesktopGateway().catch((error: any) => { console.error(error.message); process.exitCode = 1; });
}
export = { verifyDesktopGateway, isolatedEnvironment };
