import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import identity = require('../lib/delivery-identity');
import nativeInputs = require('./desktop-rust-inputs');
import development = require('../lib/rust-development');
import { desktopBuildProfile, desktopRuntimeExecutable, desktopRuntimeReceipt } from '../lib/desktop-build-profile';


const root = path.resolve(__dirname, '../..');
const manifest = path.join(root, 'runtime-rs', 'Cargo.toml');
const cargoHome = process.env.CARGO_HOME || path.join(os.homedir(), '.cargo');
const candidate = path.join(cargoHome, 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo');
const cargo = fs.existsSync(candidate) ? candidate : 'cargo';
const env: NodeJS.ProcessEnv = { ...process.env, CARGO_TARGET_DIR: path.join(root,'runtime-rs','target'), PATH: path.join(cargoHome, 'bin') + path.delimiter + (process.env.PATH || '') };

function run(args: string[], command = cargo, supplied = env): void {
  const result = spawnSync(command, args, { cwd: root, env: supplied, windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function main(): Promise<void> {
  const action = process.argv[2];
  if (process.argv.includes('--help')) {
    if(action==='recover') console.log('run-rust-runtime recover --root <absolute project> --runtime-root <absolute runtime> [--showcase-root <absolute root>] [--backup-id <id>] [--out <new plan>] | --apply-plan <signed plan>');
    else console.log('run-rust-runtime <build|start|build-dev|start-dev|catalog|recover>\nbuild [--profile release|desktop-local]: locked runtime with a profile-specific binding\nstart: locked release runtime\nbuild-dev/start-dev: independent fast dev cache; no release receipt\nAICS_RUST_DEV_MODE=standard restores Cargo dev defaults; AICS_RUST_DEV_LINKER=default retains the configured linker\nrecover: existing release recovery executable; default is preview');
  } else if ((action === 'build-dev' && process.argv.length === 3) || action === 'start-dev') {
    const built = await development.buildDevelopmentRuntime(root);
    console.log(`[rust dev] ${built.executable}`);
    if (action === 'start-dev') {
      run(process.argv.slice(3), built.executable, nativeInputs.developmentNativeEnvironment(root, built.env));
    }
  } else if (action === 'build') {
    const args = process.argv.slice(3);
    if (args.length && (args.length !== 2 || args[0] !== '--profile')) throw Error('Expected build [--profile release|desktop-local]');
    const profile = desktopBuildProfile(args[1]);
    const selected = nativeInputs.SOURCES;
    const before = identity.snapshot(root, selected);
    if (before.status !== 'complete') throw new Error('Rust source identity is incomplete');
    run(['build', '--manifest-path', manifest, '--locked', '--profile', profile]);
    const source = identity.snapshot(root, selected);
    if (source.sha256 !== before.sha256) throw new Error('Rust sources changed during the build; rebuild the stable candidate');
    const executable = path.join(root, desktopRuntimeExecutable(profile));
    const bytes = fs.readFileSync(executable);
    const directory = path.join(root, 'runtime', 'rust-evidence');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(root, desktopRuntimeReceipt(profile)), JSON.stringify({ formatVersion: 1, buildProfile: profile, builtAt: new Date().toISOString(), source,
      binary: { path: path.relative(root, executable).replaceAll('\\', '/'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } }, null, 2) + '\n');
  } else if(action==='start') {
    Object.assign(env,nativeInputs.developmentNativeEnvironment(root,env));
    run(['run','--manifest-path',manifest,'--locked','--release','--',...process.argv.slice(3)]);
  } else if(action==='catalog') {
    run(['run','--manifest-path',manifest,'--locked','--','catalog',...process.argv.slice(3)]);
  } else if(action==='recover') {
    const executable=path.join(root,'runtime-rs','target','release',process.platform==='win32'?'huiyu-runtime.exe':'huiyu-runtime');
    if(!fs.existsSync(executable))throw Error('Build the native recovery tool first: npm run wf -- rust:build');
    const result=spawnSync(executable,['maintenance-recovery',...process.argv.slice(3)],{cwd:root,env,windowsHide:true,stdio:'inherit'});
    if(result.error)throw result.error;
    process.exitCode=result.status ?? 1;
  } else {
    console.error('Expected build, start, build-dev, start-dev, catalog or recover; use --help');
    process.exitCode = 2;
  }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
