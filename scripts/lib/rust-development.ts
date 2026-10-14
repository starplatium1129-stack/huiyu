import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import { spawn, spawnSync } from 'node:child_process';

const MSVC_LINKER = 'CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER';
type DevelopmentCargo = { cargo: string; env: NodeJS.ProcessEnv };

/** Defaults apply only to development children. Caller overrides remain authoritative. */
function developmentCargo(manifest: string, cwd: string, source: NodeJS.ProcessEnv = process.env, defaultLinker: 'default' | 'lld' = 'default'): DevelopmentCargo {
  const env = { ...source };
  const mode = env.AICS_RUST_DEV_MODE || 'fast';
  const preference = env.AICS_RUST_DEV_LINKER || defaultLinker;
  if (!['fast', 'standard'].includes(mode)) throw Error('AICS_RUST_DEV_MODE must be fast or standard');
  if (!['lld', 'default'].includes(preference)) throw Error('AICS_RUST_DEV_LINKER must be lld or default');
  const bin = path.join(env.CARGO_HOME || path.join(os.homedir(), '.cargo'), 'bin');
  const candidate = path.join(bin, process.platform === 'win32' ? 'cargo.exe' : 'cargo');
  const cargo = fs.existsSync(candidate) ? candidate : 'cargo';
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
  env[pathKey] = bin + path.delimiter + (env[pathKey] || '');
  let linker = 'default';
  if (mode === 'fast') {
    env.CARGO_PROFILE_DEV_DEBUG ??= '1';
    // Do not overwrite a caller's linker or Rust flag source. This opt-in entry
    // overrides Cargo config's MSVC linker; use preference=default to retain it.
    if (env[MSVC_LINKER] !== undefined || Object.keys(env).some(key => /^(?:RUSTFLAGS|CARGO_ENCODED_RUSTFLAGS|CARGO_BUILD_RUSTFLAGS|CARGO_TARGET_.+_RUSTFLAGS)$/.test(key))) linker = 'custom';
    else if (preference === 'lld' && process.platform === 'win32' && process.arch === 'x64') {
      const rustc = env.RUSTC || env.CARGO_BUILD_RUSTC || path.join(bin, 'rustc.exe');
      const compiler = fs.existsSync(rustc) ? rustc : (env.RUSTC || env.CARGO_BUILD_RUSTC || 'rustc');
      const version = spawnSync(compiler, ['-vV'], { cwd, env, encoding: 'utf8', windowsHide: true });
      if (version.status === 0 && /host: x86_64-pc-windows-msvc/.test(version.stdout)) {
        const sysroot = spawnSync(compiler, ['--print', 'sysroot'], { cwd, env, encoding: 'utf8', windowsHide: true });
        const lld = path.join(sysroot.stdout?.trim() || '', 'lib/rustlib/x86_64-pc-windows-msvc/bin/rust-lld.exe');
        if (sysroot.status === 0 && fs.existsSync(lld)) { env[MSVC_LINKER] = lld; linker = 'lld'; }
      }
      if (linker !== 'lld') console.warn('[rust dev] Compatible bundled LLD unavailable; using the configured linker.');
    }
  }
  if (env.CARGO_TARGET_DIR === undefined && env.CARGO_BUILD_TARGET_DIR === undefined) {
    env.CARGO_TARGET_DIR = mode === 'standard' ? path.join(path.dirname(manifest), 'target')
      : path.join(path.dirname(manifest), 'target/development', linker);
  }
  console.log(`[rust dev] ${mode}; debug=${env.CARGO_PROFILE_DEV_DEBUG ?? 'Cargo default'}; linker=${linker}; cache=${env.CARGO_TARGET_DIR ?? env.CARGO_BUILD_TARGET_DIR}`);
  return { cargo, env };
}

/** Read Cargo's actual executable path rather than guessing target/triple/profile directories. */
async function buildDevelopmentRuntime(root: string, context?: DevelopmentCargo): Promise<{ executable: string; env: NodeJS.ProcessEnv }> {
  const manifest = path.join(root, 'runtime-rs/Cargo.toml');
  const prepared = context || developmentCargo(manifest, root);
  const normalize = (file: string) => {
    const value = path.resolve(file).replace(/^\\\\\?\\/, '');
    return process.platform === 'win32' ? value.toLowerCase() : value;
  };
  let executable: string | undefined, pending = '';
  const compiling = spawn(prepared.cargo, ['build', '--locked', '--manifest-path', manifest, '--message-format=json-render-diagnostics'], {
    cwd: root, env: prepared.env, stdio: ['inherit', 'pipe', 'inherit'], windowsHide: true,
  });
  function consume(line: string) {
    let message: any;
    try { message = JSON.parse(line); } catch { if (line.trim()) console.log(line); return; }
    if (message && typeof message === 'object' && message.reason === 'compiler-artifact' && message.target?.name === 'huiyu-runtime'
        && Array.isArray(message.target.kind) && message.target.kind.includes('bin') && typeof message.manifest_path === 'string'
        && normalize(message.manifest_path) === normalize(manifest) && typeof message.executable === 'string') executable = message.executable;
  }
  compiling.stdout!.setEncoding('utf8');
  compiling.stdout!.on('data', (chunk: string) => {
    pending += chunk;
    const lines = pending.split('\n'); pending = lines.pop() || '';
    for (const line of lines) consume(line);
  });
  await new Promise<void>((resolve, reject) => {
    compiling.once('error', reject);
    compiling.once('close', code => code === 0 ? resolve() : reject(Error(`Rust build failed (${code}); no replacement started`)));
  });
  if (pending) consume(pending);
  if (!executable) throw Error('Cargo did not return the built huiyu-runtime executable');
  return { executable, env: prepared.env };
}

export = { developmentCargo, buildDevelopmentRuntime };
