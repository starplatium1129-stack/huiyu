'use strict';
import fs = require('node:fs');
import path = require('node:path');
import { execFile, execFileSync } from 'node:child_process';
import { timeDesktopBuild } from '../lib/desktop-build-timing';
import { purgeWoffFonts } from './precompress';
import { errorStack } from '../lib/runtime-errors';
import type { DesktopBuildProfile } from '../lib/desktop-build-profile';
import type { Snapshot } from '../lib/delivery-types';
const { withWorkspaceLock }: typeof import('../lib/workspace-lock') = require('../lib/workspace-lock');
const { stageResources, resolveNpmInvocation }: typeof import('./desktop-stage-resources') = require('./desktop-stage-resources');
const ROOT = path.resolve(__dirname, '../..');

type PrepareOptions = {
  root?: string;
  buildProfile?: DesktopBuildProfile;
  source?: Snapshot;
  buildWeb?: boolean;
  direct?: boolean;
  reuseUi?: boolean;
  refreshDataSidecars?: boolean;
};

/** Parallel children report one phase at a time to keep the deploy log readable. */
function runBuildTool(executable: string, args: string[], cwd: string, buffered: boolean, env = process.env) {
  if (!buffered) {
    execFileSync(executable, args, { cwd, env, stdio: 'inherit', windowsHide: true });
    return;
  }
  return new Promise<void>((resolve, reject) => {
    execFile(executable, args, { cwd, env, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      if (error) reject(error);
      else resolve();
    });
  });
}

async function prepareTauri(options: PrepareOptions = {}) {
  const root = options.root || ROOT, webDir = path.join(root, 'desktop-tauri/web');
  const buildProfile = options.buildProfile || 'release';
  const local = buildProfile === 'desktop-local';
  const webEnvironment: NodeJS.ProcessEnv = { ...process.env, AICS_PRECOMPRESS_FAST: local ? '1' : '0' };
  if (local) webEnvironment.UV_THREADPOOL_SIZE ??= '8';
  const assets = () => timeDesktopBuild(options.direct ? 'resource cleanup tool' : 'installer assets', () =>
    runBuildTool(process.execPath, [path.join(root, 'scripts/maintenance/build-game-installer.js'),
      ...(options.direct ? ['--resources-only'] : [])], root, local));
  const runtime = () => timeDesktopBuild(`Rust runtime (${buildProfile})`, () =>
    runBuildTool(process.execPath, [path.join(root, 'scripts/maintenance/run-rust-runtime.js'), 'build', '--profile', buildProfile], root, local));
  const gatewayWeb = () => {
    const npm = resolveNpmInvocation();
    // The caller's desktop entry point already compiled runtime tools.
    return timeDesktopBuild('web build and precompression', () =>
      runBuildTool(npm.command, [...npm.args, 'run', 'build:web:run'], root, local, webEnvironment));
  };
  const desktopWeb = async () => {
    await timeDesktopBuild('desktop UI', () => runBuildTool(process.execPath,
      [path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js'), 'build', '--mode', 'desktop', '--outDir', webDir], root, local));
    if (!fs.existsSync(path.join(webDir, 'index.html'))) throw Error('Desktop bundled UI was not built');
    purgeWoffFonts(root, 'desktop-tauri/web');
  };
  const prepareWeb = async () => {
    if (options.reuseUi) {
      console.log('[tauri] Reusing verified dist and desktop-tauri/web');
      if (options.refreshDataSidecars) await timeDesktopBuild('data precompression', () =>
        runBuildTool(process.execPath, [path.join(root, 'scripts/maintenance/precompress.js'), '--data-only'], root, true, webEnvironment));
      return;
    }
    if (options.buildWeb) await gatewayWeb();
    await desktopWeb();
  };
  if (local) {
    const completed = await Promise.allSettled([runtime(), prepareWeb(), assets()]);
    for (const result of completed) if (result.status === 'rejected') throw result.reason;
  } else {
    if (options.buildWeb) await gatewayWeb();
    await assets();
    await runtime();
    await desktopWeb();
  }
  const staged = await timeDesktopBuild('resource staging', () => stageResources({ root, buildProfile, source: options.source }));
  console.log(`[tauri] Rust candidate prepared; releaseReady=${staged.releaseReady}`);
  return { webDir, ...staged };
}
if (require.main === module) withWorkspaceLock({ workspaceRoot: ROOT }, () => prepareTauri()).catch((error: unknown) => { console.error(`[tauri] prepare failed: ${errorStack(error)}`); process.exitCode = 1; });
export = { prepareTauri };
