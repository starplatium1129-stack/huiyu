'use strict';

const { spawnSync }: typeof import('node:child_process') = require('node:child_process');
const path: typeof import('node:path') = require('node:path');
const { withDesktopBuildLock }: typeof import('./desktop-build-lock') = require('./desktop-build-lock');
const { resolveNpmInvocation }: typeof import('./desktop-stage-resources') = require('./desktop-stage-resources');
const { prepareTauri }: typeof import('./prepare-tauri') = require('./prepare-tauri');
const { desktopBuildEnvironment, assertDesktopBuildEnvironment }: typeof import('./desktop-build-environment') = require('./desktop-build-environment');

const ROOT = path.resolve(__dirname, '../..');

type RunCommandOptions = {
  spawnSync?: typeof spawnSync;
  cwd?: string;
  stdio?: import('node:child_process').StdioOptions;
  env?: NodeJS.ProcessEnv;
  windowsHide?: boolean;
};

type RunTauriOptions = {
  root?: string;
  withLock?: typeof withDesktopBuildLock;
  checkEnvironment?: typeof assertDesktopBuildEnvironment;
  npmCommand?: string;
  npmArgs?: string[];
  runCommand?: typeof runCommand;
  prepareTauri?: typeof prepareTauri;
  tauriCli?: string;
  spawnTauri?: typeof runCommand;
  env?: NodeJS.ProcessEnv;
};

function tauriEnvironment(root: any = ROOT) {
  return desktopBuildEnvironment(root);
}

function runCommand(command: string, args: string[], options: RunCommandOptions = {}): number {
  const result = (options.spawnSync || spawnSync)(command, args, {
    cwd: options.cwd || ROOT,
    stdio: options.stdio || 'inherit',
    env: options.env || process.env,
    windowsHide: options.windowsHide ?? true,
  });
  if (result.error) throw result.error;
  return result.status == null ? 1 : result.status;
}

async function runTauri(argv: string[], options: RunTauriOptions = {}): Promise<number> {
  let args = [...argv];
  // 2026-08-29 updater 落地：设置了签名私钥时忽略 --no-sign（package:tauri 默认带它），
  // 否则 build 不产出 .sig，updater 发布流程拿不到签名。
  if (process.env.TAURI_SIGNING_PRIVATE_KEY || process.env.TAURI_SIGNING_PRIVATE_KEY_PATH) {
    args = args.filter((a: any) => a !== '--no-sign');
  }
  const mode = args.shift();
  if (!mode || !['dev', 'build'].includes(mode)) {
    throw new Error('usage: node scripts/maintenance/run-tauri.js <dev|build> [tauri args]');
  }

  const workspaceRoot = options.root || ROOT;
  const lock = options.withLock || withDesktopBuildLock;
  return lock({ workspaceRoot }, async () => {
    (options.checkEnvironment || assertDesktopBuildEnvironment)(workspaceRoot);
    const npm = options.npmCommand
      ? { command: options.npmCommand, args: options.npmArgs || [] }
      : resolveNpmInvocation();
    const run = options.runCommand || runCommand;
    let status = run(npm.command, [...npm.args, 'run', 'build'], { cwd: workspaceRoot });
    if (status !== 0) return status;
    status = run(npm.command, [...npm.args, 'run', 'test:services-generated'], { cwd: workspaceRoot });
    if (status !== 0) return status;

    const prepare = options.prepareTauri || prepareTauri;
    await prepare({ root: workspaceRoot });

    const cli = options.tauriCli || require.resolve('@tauri-apps/cli/tauri.js');
    const spawnTauri = options.spawnTauri || runCommand;
    return spawnTauri(process.execPath, [cli, mode, ...args], {
      cwd: path.join(workspaceRoot, 'desktop-tauri'),
      stdio: 'inherit',
      env: options.env || tauriEnvironment(workspaceRoot),
      windowsHide: false,
    });
  });
}

if (require.main === module) {
  runTauri(process.argv.slice(2)).then((status: any) => {
    process.exitCode = status;
  }).catch((error: any) => {
    console.error(`[tauri] CLI failed: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

export = { runCommand, runTauri, tauriEnvironment };
