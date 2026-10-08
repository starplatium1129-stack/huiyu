import fs = require('node:fs');
import path = require('node:path');
import { spawnSync } from 'node:child_process';
import { NATIVE_MANIFESTS, type NativeRustTarget } from '../lib/rust-check-plan';
import environment = require('./desktop-build-environment');

const root = path.resolve(__dirname, '../..');
const sdkParts = ['Core/include/Live2DCubismCore.h', 'Framework/src/CubismFramework.cpp',
  'Core/lib/windows/x86_64/143/Live2DCubismCore_MD.lib'];

export function nativePrerequisites(projectRoot: string, env: NodeJS.ProcessEnv, platform = process.platform): string[] {
  if (platform !== 'win32') return ['Windows x64 with the MSVC toolchain and Cubism Native SDK'];
  const sdk = environment.resolveSdkRoot(projectRoot, env);
  return !sdk || sdkParts.some(part => !fs.existsSync(path.join(sdk, part)))
    ? ['Complete Cubism Native SDK (LIVE2D_CUBISM_SDK_DIR or runtime/desktop-build-sdk/CubismSdkForNative-5-r.5)'] : [];
}
export function main(argv: string[]): number {
  if (argv.includes('--help')) {
    console.log('check-native-rust [--target host|renderer]\nCompile the selected native Rust target; no install, model loading or GPU tests. Missing prerequisites: exit 3 (not run).');
    return 0;
  }
  if (argv.length && (argv.length !== 2 || argv[0] !== '--target' || !Object.hasOwn(NATIVE_MANIFESTS, argv[1]))) {
    console.error('Expected --target host|renderer'); return 2;
  }
  const target = (argv[1] || 'host') as NativeRustTarget;
  const missing = nativePrerequisites(root, process.env);
  if (missing.length) { console.error('Native compilation not run: ' + missing.join('; ')); return 3; }
  const env = environment.desktopBuildEnvironment(root, process.env);
  env.CARGO_BUILD_JOBS ??= '2';
  const result = spawnSync('cargo', ['check', '--locked', '--manifest-path', path.join(root, NATIVE_MANIFESTS[target])],
    { cwd: root, env, windowsHide: true, stdio: 'inherit' });
  if (result.error && 'code' in result.error && result.error.code === 'ENOENT') {
    console.error('Native compilation not run: cargo/MSVC toolchain is unavailable'); return 3;
  }
  if (result.error) throw result.error;
  return result.status ?? 1;
}
if (require.main === module) process.exitCode = main(process.argv.slice(2));
