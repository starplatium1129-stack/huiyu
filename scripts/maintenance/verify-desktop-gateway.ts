'use strict';

// Run the exact bundle outside the repo: no borrowing developer dependencies.
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const net: typeof import('node:net') = require('node:net');
const { spawn }: typeof import('node:child_process') = require('node:child_process');
const { once }: typeof import('node:events') = require('node:events');
const ROOT = path.resolve(__dirname, '../..');

async function freePort() {
  const server: any = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise<any>((resolve: any) => server.close(resolve));
  return port;
}

async function verifyDesktopGateway({ root = ROOT, logger = console.log }: any = {}) {
  const tauri = path.join(root, 'desktop-tauri/src-tauri');
  const config = JSON.parse(fs.readFileSync(path.join(tauri, 'tauri.conf.json'), 'utf8'));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'huiyu-installed-gateway-'));
  let child;
  let exited;
  let output = '';
  try {
    for (const [source, destination] of Object.entries(config.bundle.resources)) {
      const target = path.resolve(temporary, destination);
      if (!target.startsWith(temporary + path.sep)) throw new Error('Bundle destination escapes installation');
      fs.cpSync(path.join(tauri, source), target, { recursive: true });
    }
    const gateway = path.join(temporary, 'gateway');
    const port = await freePort();
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(AICS_|AI_WORKSPACE_ROOT$|SCENE_SHOWCASE_DIR$|NODE_OPTIONS$|NODE_PATH$|AUTO_TUNNEL$|TOKEN$)/i.test(key)) delete env[key];
    }
    Object.assign(env, {
      HOST: '127.0.0.1', PORT: String(port), DISABLE_TUNNEL: '1',
      AICS_APP_ROOT: gateway, AICS_RUNTIME_ROOT: path.join(temporary, 'state'),
      AI_WORKSPACE_ROOT: path.join(temporary, 'AI'), AICS_DESKTOP_PACKAGED: '1',
      AICS_DISABLE_LEGACY_RUNTIME_MIGRATION: '1',
    });
    const started = Date.now();
    child = spawn(path.join(tauri, 'binaries/node-x86_64-pc-windows-msvc.exe'), [path.join(gateway, 'server.js')], {
      cwd: gateway, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    exited = once(child, 'close');
    exited.catch(() => {});
    child.stdout.on('data', (data: any) => { output = (output + data).slice(-16000); });
    child.stderr.on('data', (data: any) => { output = (output + data).slice(-16000); });
    const base = `http://127.0.0.1:${port}`;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`Packaged gateway exited: ${output}`);
      try {
        const response = await fetch(base + '/api/health', { signal: AbortSignal.timeout(1500) });
        const health = await response.json();
        if (response.ok && health.ok && health.app === 'ai-cg-studio' && health.gateway) break;
      } catch { /* Bound readiness retries. */ }
      if (Date.now() - started > 20000) throw new Error(`Packaged gateway readiness timed out: ${output}`);
      await new Promise<any>((resolve: any) => setTimeout(resolve, 100));
    }
    const readyMs = Date.now() - started;
    for (const route of ['/', '/companion', '/companion-chat', '/docs/INDEX.md']) {
      const response = await fetch(base + route, { signal: AbortSignal.timeout(5000) });
      if (!response.ok || !(await response.text()).length) throw new Error(`Packaged route ${route}: HTTP ${response.status}`);
    }
    const redirects = JSON.parse(fs.readFileSync(path.join(gateway, 'docs/redirects.json'), 'utf8'));
    const [from, to] = Object.entries(redirects)[0];
    const response = await fetch(base + from, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    if (response.status !== 308 || response.headers.get('location') !== to) throw new Error('Packaged documentation redirect failed');
    logger(`[desktop:verify-gateway] PASS: isolated bundle healthy in ${readyMs}ms; studio, companion, chat and docs available`);
    return { readyMs };
  } finally {
    if (child && child.exitCode === null) child.kill();
    if (exited) await exited.catch(() => {});
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (require.main === module) {
  if (process.argv.includes('--help')) console.log('Verify staged Windows gateway using the exact bundle mapping in an isolated temporary installation.');
  else verifyDesktopGateway().catch((error: any) => { console.error(error.message); process.exitCode = 1; });
}
export = { verifyDesktopGateway };
