'use strict';
import { timeDesktopBuild } from '../lib/desktop-build-timing';
import { errorStack } from '../lib/runtime-errors';
import fs = require('node:fs');
import os = require('node:os');
import identity = require('../lib/delivery-identity');
import * as localReuse from '../lib/desktop-local-reuse';
import type { Snapshot } from '../lib/delivery-types';
import development = require('../lib/rust-development');
import nativeInputs = require('./desktop-rust-inputs');
import type { DesktopBuildProfile } from '../lib/desktop-build-profile';
import safe = require('../lib/delivery-paths');

const { spawnSync }: typeof import('node:child_process') = require('node:child_process');
const path: typeof import('node:path') = require('node:path');
const { withWorkspaceLock }: typeof import('../lib/workspace-lock') = require('../lib/workspace-lock');
const { prepareTauri }: typeof import('./prepare-tauri') = require('./prepare-tauri');
const { desktopBuildEnvironment, assertDesktopBuildEnvironment }: typeof import('../lib/desktop-build-environment') = require('../lib/desktop-build-environment');

const ROOT = path.resolve(__dirname, '../..');
const binding: typeof import('../lib/desktop-build-binding') = require('../lib/desktop-build-binding');

type RunCommandOptions = {
  cwd?: string;
  stdio?: import('node:child_process').StdioOptions;
  env?: NodeJS.ProcessEnv;
  windowsHide?: boolean;
};

function runCommand(command: string, args: string[], options: RunCommandOptions = {}): number {
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    stdio: options.stdio || 'inherit',
    env: options.env || process.env,
    windowsHide: options.windowsHide ?? true,
  });
  if (result.error) throw result.error;
  return result.status == null ? 1 : result.status;
}

function localMsvcLinker(root: string, env: NodeJS.ProcessEnv) {
  const linker = 'CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER';
  const flags = [env.RUSTFLAGS, env.CARGO_ENCODED_RUSTFLAGS, env.CARGO_BUILD_RUSTFLAGS,
    env.CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS].join(' ');
  if (env.CARGO_BUILD_TARGET || env[linker] !== undefined || /\blinker(?:=|\s)/.test(flags)) return;
  const bin = path.join(env.CARGO_HOME || path.join(os.homedir(), '.cargo'), 'bin');
  const bundled = development.bundledMsvcLinker(path.join(root, 'desktop-tauri'), env, bin);
  if (bundled) {
    env[linker] = bundled;
    console.log('[tauri] desktop-local linker: rust-lld');
  }
}

async function prepareLocalBuild(root: string, source: Snapshot, sdk: string, args: string[], env: NodeJS.ProcessEnv,
    useCachedOutputs: boolean, direct: boolean) {
  const frontend = localReuse.frontendInput(root, source, env);
  const previous = useCachedOutputs ? localReuse.readLocalReuse(root, binding.receiptPath) : undefined;
  let reusedUi: Snapshot | undefined;
  if (previous?.inputs.frontend === frontend) {
    const existing = await timeDesktopBuild('cached frontend verification', () => identity.snapshotParallel(root, localReuse.uiOutputs));
    if (localReuse.matchOutputs(existing, previous.build, localReuse.uiOutputs)) reusedUi = existing;
  }
  await prepareTauri({ root, buildProfile: 'desktop-local', source, buildWeb: true, direct,
    reuseUi: Boolean(reusedUi), refreshDataSidecars: Boolean(reusedUi) && previous?.inputs.data !== localReuse.dataCompressionState(root) });
  if (localReuse.frontendInput(root, source, env) !== frontend) {
    throw Error('前端输入在构建期间发生变化，请重新构建');
  }
  const ui = reusedUi ?? await timeDesktopBuild('frontend artifact identity', () => identity.snapshotParallel(root, localReuse.uiOutputs));
  if (ui.status !== 'complete') throw Error('桌面前端产物不完整，请重新构建');
  const host = localReuse.hostInput(root, source, sdk, ui, args, env);
  let reusedHost: Snapshot | undefined;
  if (host && previous?.inputs.host === host) {
    const existing = await identity.snapshotParallel(root, localReuse.hostOutputs);
    if (localReuse.matchOutputs(existing, previous.build, localReuse.hostOutputs)) reusedHost = existing;
  }
  return {
    reusedHost,
    inputs: host ? { frontend, host, data: localReuse.dataCompressionState(root) } : undefined,
    verifyOutputs: (build: Snapshot) => localReuse.assertBoundOutputs(build, ui, reusedHost),
  };
}

async function runTauri(argv: string[]): Promise<number> {
  let args = [...argv];
  // 2026-08-29 updater 落地：设置了签名私钥时忽略 --no-sign（package:tauri 默认带它），
  // 否则 build 不产出 .sig，updater 发布流程拿不到签名。
  if (process.env.TAURI_SIGNING_PRIVATE_KEY || process.env.TAURI_SIGNING_PRIVATE_KEY_PATH) {
    args = args.filter(a => a !== '--no-sign');
  }
  const mode = args.shift();
  if (!mode || !['dev', 'build'].includes(mode)) {
    throw new Error('usage: node scripts/maintenance/run-tauri.js <dev|build> [tauri args]');
  }

  const workspaceRoot = ROOT;
  const separator = args.indexOf('--');
  const cliArgs = separator < 0 ? args : args.slice(0, separator);
  if (cliArgs.some(arg => arg === '--help' || arg === '-h')) {
    if (mode === 'dev') console.log('[tauri dev] --refresh-ui rebuilds both UI entries; Rust-only development reuses them.');
    else console.log('[tauri build] --local selects desktop-local and requires --no-bundle. --direct skips installer assets for local deployment. Default: release.');
    return runCommand(process.execPath, [require.resolve('@tauri-apps/cli/tauri.js'), mode, ...args.filter(arg => arg !== '--local' && arg !== '--direct')], { cwd: path.join(workspaceRoot, 'desktop-tauri') });
  }
  const forwarded = separator < 0 ? [] : args.slice(separator + 1);
  const applicationSeparator = forwarded.indexOf('--');
  const cargoArgs = applicationSeparator < 0 ? forwarded : forwarded.slice(0, applicationSeparator);
  const customProfile = cargoArgs.some(arg => arg === '--release' || arg === '--profile' || arg.startsWith('--profile='));
  const localBuild = cliArgs.includes('--local');
  const direct = cliArgs.includes('--direct');
  if (direct && !localBuild) throw Error('--direct requires a desktop-local build');
  const canonicalLocalBuild = separator < 0 && cliArgs.every(arg => ['--local', '--direct', '--ci', '--no-bundle', '--no-sign'].includes(arg))
    && process.env.TAURI_CONFIG === undefined;
  const buildProfile: DesktopBuildProfile = localBuild ? 'desktop-local' : 'release';
  if (localBuild && (mode !== 'build' || !cliArgs.includes('--no-bundle'))) throw Error('--local requires build --no-bundle; use desktop:package-local for a local installer.');
  if (mode === 'build' && (customProfile || cliArgs.includes('--debug') || cliArgs.includes('-d'))) throw Error('Bound desktop builds require the default release profile or --local; do not override the Cargo profile.');
  if (localBuild) {
    args.splice(args.indexOf('--local'), 1);
    if (direct) args.splice(args.indexOf('--direct'), 1);
    if (!args.includes('--')) args.push('--');
    args.push('--profile', buildProfile);
  }
  const fastDevelopment = mode === 'dev' && !cliArgs.includes('--release') && !customProfile;
  const refreshUi = fastDevelopment && cliArgs.includes('--refresh-ui');
  if (refreshUi) args.splice(args.indexOf('--refresh-ui'), 1);
  const build = () => withWorkspaceLock({ workspaceRoot }, async () => {
    assertDesktopBuildEnvironment(workspaceRoot);
    if (mode === 'build') {
      // Packaging must refresh stale ignored products before either UI captures DATA_VERSION.
      const dataStatus = await timeDesktopBuild('data preparation', () => runCommand(process.execPath, ['-e', 'require(process.argv[1]).ensureAll()', path.join(workspaceRoot, 'scripts/lib/ensure-data-build.js')], {
        cwd: workspaceRoot, env: { ...process.env, AICS_DATA_ROOT: workspaceRoot, AICS_APP_ROOT: workspaceRoot },
      }));
      if (dataStatus !== 0) return dataStatus;
    }
    const identify = localBuild ? binding.sourceIdentityParallel : binding.sourceIdentity;
    const source = mode === 'build' ? await timeDesktopBuild('source identity', () => identify(workspaceRoot)) : null;
    let env = { ...desktopBuildEnvironment(workspaceRoot) };
    if (mode === 'build') {
      env.CARGO_TARGET_DIR = path.join(workspaceRoot, 'desktop-tauri/src-tauri/target');
      console.log(`[tauri] Build profile: ${buildProfile}`);
    }
    const sdk = mode === 'build' ? binding.sdkIdentity(workspaceRoot, env) : null;
    if (sdk) { env.LIVE2D_CUBISM_SDK_DIR = sdk.root; env.LIVE2D_CUBISM_SDK_SHA256 = sdk.inputs.sha256; }
    if (localBuild) localMsvcLinker(workspaceRoot, env);
    let local: Awaited<ReturnType<typeof prepareLocalBuild>> | undefined;
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
        const dataStatus = runCommand(process.execPath, ['-e', 'require(process.argv[1]).ensureAll()', path.join(workspaceRoot, 'scripts/lib/ensure-data-build.js')], {
          cwd: workspaceRoot, env: { ...env, AICS_DATA_ROOT: workspaceRoot, AICS_APP_ROOT: workspaceRoot },
        });
        if (dataStatus !== 0) return dataStatus;
        const vite = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js');
        for (const [directory, flags] of outputs) {
          const status = await timeDesktopBuild(`development UI ${directory}`, () => runCommand(process.execPath, [vite, 'build', ...flags, '--outDir', directory], { cwd: workspaceRoot, env }));
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
    } else if (localBuild && source && sdk) {
      local = await prepareLocalBuild(workspaceRoot, source, sdk.inputs.sha256, args, env,
        canonicalLocalBuild && process.env.AICS_DESKTOP_FORCE_BUILD !== '1', direct);
    } else {
      await prepareTauri({ root: workspaceRoot, buildProfile, buildWeb: true });
    }

    const cli = require.resolve('@tauri-apps/cli/tauri.js');
    let result = 0;
    if (local?.reusedHost) console.log('[tauri] Reusing verified desktop-local host EXE');
    else result = await timeDesktopBuild(fastDevelopment ? 'Tauri development session' : 'Tauri native build and bundle', () => runCommand(process.execPath, [cli, mode, ...args], {
      cwd: path.join(workspaceRoot, 'desktop-tauri'),
      stdio: 'inherit',
      env,
      windowsHide: false,
    }));
    if (result === 0 && source) {
      try {
        await timeDesktopBuild('build binding', () => local
          ? binding.recordBuildParallel(workspaceRoot, source, false, sdk!, buildProfile,
            canonicalLocalBuild ? local.inputs : undefined, local.verifyOutputs)
          : binding.recordBuild(workspaceRoot, source, !args.includes('--no-bundle'), sdk!, buildProfile));
      } catch (error) {
        throw Error(`Tauri CLI 已成功，但构建产物/回执校验失败；本次构建不可发行: ${error instanceof Error ? error.message : String(error)}`, { cause:error });
      }
    }
    return result;
  });
  return localBuild ? safe.withLocalFileHashes(build) : build();
}

if (require.main === module) {
  runTauri(process.argv.slice(2)).then(status => {
    process.exitCode = status;
  }).catch((error: unknown) => {
    console.error(`[tauri] CLI failed: ${errorStack(error)}`);
    process.exitCode = 1;
  });
}

export = { runTauri };
