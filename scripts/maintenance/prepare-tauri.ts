'use strict';
import fs = require('node:fs');
import path = require('node:path');
import { execFileSync } from 'node:child_process';
const { withDesktopBuildLock }: typeof import('./desktop-build-lock') = require('./desktop-build-lock');
const { stageResources }: typeof import('./desktop-stage-resources') = require('./desktop-stage-resources');
const ROOT = path.resolve(__dirname, '../..');
async function prepareTauri(options: any = {}) {
  const root = options.root || ROOT, webDir = options.webDir || path.join(root, 'desktop-tauri/web');
  await (options.buildInstaller || (() => (require('./build-game-installer') as typeof import('./build-game-installer')).buildGameInstaller()))();
  await (options.buildRuntime || (() => execFileSync(process.execPath, [path.join(root, 'scripts/maintenance/run-rust-runtime.js'), 'build'], { cwd: root, env:{...process.env,CARGO_TARGET_DIR:path.join(root,'runtime-rs/target')}, windowsHide: true, stdio: 'inherit' })))();
  await (options.buildDesktopUi || (() => execFileSync(process.execPath,
    [path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js'), 'build', '--mode', 'desktop', '--outDir', webDir],
    { cwd: root, stdio: 'inherit', windowsHide: true })))();
  if (!fs.existsSync(path.join(webDir, 'index.html'))) throw Error('Desktop bundled UI was not built');
  const staged = stageResources({ root, stage: options.stage, resourceProfile: options.resourceProfile, logger: options.logger });
  await (options.verifyGateway || (require('./verify-desktop-gateway') as typeof import('./verify-desktop-gateway')).verifyDesktopGateway)({ root });
  console.log(`[tauri] Rust candidate prepared; releaseReady=${staged.releaseReady}`);
  return { webDir, ...staged };
}
if (require.main === module) withDesktopBuildLock({ workspaceRoot: ROOT }, () => prepareTauri()).catch((error: any) => { console.error(`[tauri] prepare failed: ${error.stack || error.message}`); process.exitCode = 1; });
export = { prepareTauri };
