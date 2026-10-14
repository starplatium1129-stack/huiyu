'use strict';
import { timeDesktopBuild } from '../lib/desktop-build-timing';
import fs = require('node:fs');
import development = require('../lib/rust-development');
import nativeInputs = require('./desktop-rust-inputs');

const { spawnSync }: typeof import('node:child_process') = require('node:child_process');
const path: typeof import('node:path') = require('node:path');
const { withDesktopBuildLock }: typeof import('./desktop-build-lock') = require('./desktop-build-lock');
const { resolveNpmInvocation }: typeof import('./desktop-stage-resources') = require('./desktop-stage-resources');
const { prepareTauri }: typeof import('./prepare-tauri') = require('./prepare-tauri');
const { desktopBuildEnvironment, assertDesktopBuildEnvironment }: typeof import('./desktop-build-environment') = require('./desktop-build-environment');

const ROOT = path.resolve(__dirname, '../..');
const binding: typeof import('../lib/desktop-build-binding') = require('../lib/desktop-build-binding');

type RunCommandOptions = {
  spawnSync?: typeof spawnSync;
  cwd?: string;
  stdio?: import('node:child_process').StdioOptions;
  env?: NodeJS.ProcessEnv;
  windowsHide?: boolean;
};

type RunTauriOptions = {
  binding?: Pick<typeof binding, 'sourceIdentity' | 'sdkIdentity' | 'recordBuild'>;
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
  const separator = args.indexOf('--');
  const cliArgs = separator < 0 ? args : args.slice(0, separator);
  if (cliArgs.some(arg => arg === '--help' || arg === '-h')) {
    if (mode === 'dev') console.log('[tauri dev] --refresh-ui rebuilds both UI entries; Rust-only development reuses them.');
    return (options.spawnTauri || runCommand)(process.execPath, [options.tauriCli || require.resolve('@tauri-apps/cli/tauri.js'), mode, ...args], { cwd: path.join(workspaceRoot, 'desktop-tauri') });
  }
  const forwarded = separator < 0 ? [] : args.slice(separator + 1);
  const applicationSeparator = forwarded.indexOf('--');
  const cargoArgs = applicationSeparator < 0 ? forwarded : forwarded.slice(0, applicationSeparator);
  const customProfile = cargoArgs.some(arg => arg === '--release' || arg === '--profile' || arg.startsWith('--profile='));
  const fastDevelopment = mode === 'dev' && !cliArgs.includes('--release') && !customProfile;
  const refreshUi = fastDevelopment && cliArgs.includes('--refresh-ui');
  if (refreshUi) args.splice(args.indexOf('--refresh-ui'), 1);
  const lock = options.withLock || withDesktopBuildLock;
  return lock({ workspaceRoot }, async () => {
    (options.checkEnvironment || assertDesktopBuildEnvironment)(workspaceRoot);
    const buildBinding = options.binding || binding;
    const run = options.runCommand || runCommand;
    if (mode === 'build') {
      // Packaging must refresh stale ignored products before either UI captures DATA_VERSION.
      const dataStatus = await timeDesktopBuild('data preparation', () => run(process.execPath, ['-e', 'require(process.argv[1]).ensureAll()', path.join(workspaceRoot, 'scripts/lib/ensure-data-build.js')], {
        cwd: workspaceRoot, env: { ...process.env, AICS_DATA_ROOT: workspaceRoot, AICS_APP_ROOT: workspaceRoot },
      }));
      if (dataStatus !== 0) return dataStatus;
    }
    const source = mode === 'build' ? await timeDesktopBuild('source identity', () => buildBinding.sourceIdentity(workspaceRoot)) : null;
    let env = { ...(options.env || tauriEnvironment(workspaceRoot)) };
    const sdk = mode === 'build' ? buildBinding.sdkIdentity(workspaceRoot, env) : null;
    if (sdk) { env.LIVE2D_CUBISM_SDK_DIR = sdk.root; env.LIVE2D_CUBISM_SDK_SHA256 = sdk.inputs.sha256; }
    if (fastDevelopment) {
      const flags = [env.RUSTFLAGS, env.CARGO_ENCODED_RUSTFLAGS, env.CARGO_BUILD_RUSTFLAGS,
        ...Object.entries(env).filter(([key]) => /^CARGO_TARGET_.+_RUSTFLAGS$/.test(key)).map(([, value]) => value)].join(' ');
      if (env.CARGO_PROFILE_DEV_DEBUG_ASSERTIONS === 'false' || /debug-assertions(?:=|\s+)(?:no|off|false|0)\b/.test(flags)) {
        throw Error('Tauri development requires dev debug_assertions to select the explicit runtime EXE; remove the disabling override.');
      }
      // Source-mode legacy windows use dist; activated native windows use the
      // desktop hash-router bundle. Rust-only iteration reuses both products.
      const outputs = [['dist', []], ['desktop-tauri/web', ['--mode', 'desktop']]] as const;
      const missingUi = outputs.some(([directory]) => !fs.existsSync(path.join(workspaceRoot, directory, 'index.html')));
      if (refreshUi || missingUi) {
        const dataStatus = run(process.execPath, ['-e', 'require(process.argv[1]).ensureAll()', path.join(workspaceRoot, 'scripts/lib/ensure-data-build.js')], {
          cwd: workspaceRoot, env: { ...env, AICS_DATA_ROOT: workspaceRoot, AICS_APP_ROOT: workspaceRoot },
        });
        if (dataStatus !== 0) return dataStatus;
        const vite = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js');
        for (const [directory, flags] of outputs) {
          const status = await timeDesktopBuild(`development UI ${directory}`, () => run(process.execPath, [vite, 'build', ...flags, '--outDir', directory], { cwd: workspaceRoot, env }));
          if (status !== 0) return status;
        }
      } else console.log('[tauri dev] Reusing dist and desktop-tauri/web; use --refresh-ui after UI/content changes.');
      const native = nativeInputs.developmentNativeEnvironment(workspaceRoot, env);
      const runtime = await timeDesktopBuild('development Rust runtime', () => development.buildDevelopmentRuntime(workspaceRoot,
        development.developmentCargo(path.join(workspaceRoot, 'runtime-rs/Cargo.toml'), workspaceRoot, native)));
      const desktop = path.join(workspaceRoot, 'desktop-tauri/src-tauri');
      env = development.developmentCargo(path.join(desktop, 'Cargo.toml'), desktop, native, 'lld').env;
      // Cargo interprets relative target directories from its actual cwd.
      env.CARGO_TARGET_DIR = path.resolve(desktop, env.CARGO_TARGET_DIR ?? env.CARGO_BUILD_TARGET_DIR!);
      env.AICS_DESKTOP_RUNTIME_EXE = runtime.executable;
      const split = args.indexOf('--');
      args.splice(split < 0 ? args.length : split, 0, '--no-dev-server', '--config', JSON.stringify({ build: { devUrl: null }, bundle: { resources: [] } }));
    } else {
      const npm = options.npmCommand
        ? { command: options.npmCommand, args: options.npmArgs || [] }
        : resolveNpmInvocation();
      const status = await timeDesktopBuild('web build and precompression', () => run(npm.command, [...npm.args, 'run', 'build'], { cwd: workspaceRoot }));
      if (status !== 0) return status;

      const prepare = options.prepareTauri || prepareTauri;
      await prepare({ root: workspaceRoot });
    }

    const cli = options.tauriCli || require.resolve('@tauri-apps/cli/tauri.js');
    const spawnTauri = options.spawnTauri || runCommand;
    const result = await timeDesktopBuild(fastDevelopment ? 'Tauri development session' : 'Tauri native build and bundle', () => spawnTauri(process.execPath, [cli, mode, ...args], {
      cwd: path.join(workspaceRoot, 'desktop-tauri'),
      stdio: 'inherit',
      env,
      windowsHide: false,
    }));
    if (result === 0 && source) {
      try { await timeDesktopBuild('build binding', () => buildBinding.recordBuild(workspaceRoot, source, !args.includes('--no-bundle'), sdk!)); }
      catch (error) {
        throw Error(`Tauri CLI 已成功，但构建产物/回执校验失败；本次构建不可发行: ${error instanceof Error ? error.message : String(error)}`, { cause:error });
      }
    }
    return result;
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
