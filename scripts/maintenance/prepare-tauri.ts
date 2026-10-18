'use strict';
import fs = require('node:fs');
import path = require('node:path');
import { execFileSync } from 'node:child_process';
import { timeDesktopBuild } from '../lib/desktop-build-timing';
import { errorStack } from '../lib/runtime-errors';
const { withDesktopBuildLock }: typeof import('./desktop-build-lock') = require('./desktop-build-lock');
const { stageResources }: typeof import('./desktop-stage-resources') = require('./desktop-stage-resources');
const ROOT = path.resolve(__dirname, '../..');
async function prepareTauri(options: { root?: string } = {}) {
  const root = options.root || ROOT, webDir = path.join(root, 'desktop-tauri/web');
  await timeDesktopBuild('installer assets', (() => (require('./build-game-installer') as typeof import('./build-game-installer')).buildGameInstaller()));
  await timeDesktopBuild('Rust runtime', (() => execFileSync(process.execPath, [path.join(root, 'scripts/maintenance/run-rust-runtime.js'), 'build'], { cwd: root, env:{...process.env,CARGO_TARGET_DIR:path.join(root,'runtime-rs/target')}, windowsHide: true, stdio: 'inherit' })));
  await timeDesktopBuild('desktop UI', (() => execFileSync(process.execPath,
    [path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js'), 'build', '--mode', 'desktop', '--outDir', webDir],
    { cwd: root, stdio: 'inherit', windowsHide: true })));
  if (!fs.existsSync(path.join(webDir, 'index.html'))) throw Error('Desktop bundled UI was not built');
  const staged = await timeDesktopBuild('resource staging', () => stageResources({ root }));
  console.log(`[tauri] Rust candidate prepared; releaseReady=${staged.releaseReady}`);
  return { webDir, ...staged };
}
if (require.main === module) withDesktopBuildLock({ workspaceRoot: ROOT }, () => prepareTauri()).catch((error: unknown) => { console.error(`[tauri] prepare failed: ${errorStack(error)}`); process.exitCode = 1; });
export = { prepareTauri };
