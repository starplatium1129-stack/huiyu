import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import identity = require('../lib/delivery-identity');
import nativeInputs = require('./desktop-rust-inputs');

const root = path.resolve(__dirname, '../..');
const manifest = path.join(root, 'runtime-rs', 'Cargo.toml');
const cargoHome = process.env.CARGO_HOME || path.join(os.homedir(), '.cargo');
const candidate = path.join(cargoHome, 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo');
const cargo = fs.existsSync(candidate) ? candidate : 'cargo';
const env: NodeJS.ProcessEnv = { ...process.env, CARGO_TARGET_DIR: path.join(root,'runtime-rs','target'), PATH: path.join(cargoHome, 'bin') + path.delimiter + (process.env.PATH || '') };

function run(args: string[]): void {
  const result = spawnSync(cargo, args, { cwd: root, env, windowsHide: true, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const action = process.argv[2];
if (process.argv.includes('--help')) {
  if(action==='recover') console.log('run-rust-runtime recover --root <absolute project> --runtime-root <absolute runtime> [--showcase-root <absolute root>] [--backup-id <id>] [--out <new plan>] | --apply-plan <signed plan>');
  else console.log('run-rust-runtime <check|build|start|recover>\ncheck: fmt, clippy and isolated Rust tests\nbuild: locked release runtime; no install\nstart: run the Rust service from source\nrecover: explicit native maintenance recovery; default is preview');
} else if (action === 'check' && process.argv.length === 3) {
  // Windows TEMP may use an 8.3 alias. Isolated fixtures must receive its
  // physical spelling so runtime path guards can keep rejecting junctions.
  const testTemporary = fs.realpathSync.native(os.tmpdir());
  Object.assign(env, { TEMP: testTemporary, TMP: testTemporary });
  // Parallel integration-crate linkage can exceed Windows commit/page-file
  // limits even with free RAM. Bound checks; callers can select their measured
  // safe parallelism with CARGO_BUILD_JOBS. Normal release builds stay unchanged.
  env.CARGO_BUILD_JOBS ??= '2';
  run(['fmt', '--manifest-path', manifest, '--check']);
  run(['clippy', '--manifest-path', manifest, '--locked', '--all-targets', '--', '-D', 'warnings']);
  run(['test', '--manifest-path', manifest, '--locked']);
} else if (action === 'build' && process.argv.length === 3) {
  const selected = [{ kind: 'tree', path: 'runtime-rs/src' }, { kind: 'file', path: 'runtime-rs/Cargo.toml' }, { kind: 'file', path: 'runtime-rs/Cargo.lock' }];
  const before = identity.snapshot(root, selected);
  if (before.status !== 'complete') throw new Error('Rust source identity is incomplete');
  run(['build', '--manifest-path', manifest, '--locked', '--release']);
  const source = identity.snapshot(root, selected);
  if (source.sha256 !== before.sha256) throw new Error('Rust sources changed during the build; rebuild the stable candidate');
  const executable = path.join(root, 'runtime-rs', 'target', 'release', process.platform === 'win32' ? 'huiyu-runtime.exe' : 'huiyu-runtime');
  const bytes = fs.readFileSync(executable);
  const directory = path.join(root, 'runtime', 'rust-evidence');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'build.json'), JSON.stringify({ formatVersion: 1, builtAt: new Date().toISOString(), source,
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
  console.error('Expected check, build, start or recover; use --help');
  process.exitCode = 2;
}
