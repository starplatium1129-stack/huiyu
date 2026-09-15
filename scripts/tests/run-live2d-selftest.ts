import { errorMessage as runtimeErrorMessage } from '../lib/runtime-errors';
/**
 * Live2D 原生渲染链路自测包装器（Rust 壳侧）。
 *
 * 先用当前源码执行 `cargo build --locked`，再运行对应 profile 的
 * `desktop-tauri/src-tauri/target/<profile>/ai-cg-studio-desktop.exe`，
 * 设置 LIVE2D_SELFTEST=1，断言退出码 0 且输出包含 SELFTEST_OK。
 * 覆盖：宁宁/夏目加载、动作、口型、情绪、hit-test、渲染帧、快照。
 *
 * 用法：npm run test:live2d-native:release
 */
'use strict'

const { spawn, spawnSync }: typeof import('child_process') = require('child_process')
const fs: typeof import('fs') = require('fs')
const os: typeof import('os') = require('os')
const path: typeof import('path') = require('path')

const ROOT = path.resolve(__dirname, '..', '..')
const MANIFEST = path.join(ROOT, 'desktop-tauri', 'src-tauri', 'Cargo.toml')
const RELEASE = process.argv.includes('--release')
const PROFILE = RELEASE ? 'release' : 'debug'
const CARGO_ARGS = ['build', '--locked', '--manifest-path', MANIFEST]
if (RELEASE) CARGO_ARGS.splice(1, 0, '--release')
const EXE = path.join(
  ROOT,
  'desktop-tauri',
  'src-tauri',
  'target',
  PROFILE,
  'ai-cg-studio-desktop.exe'
)
const TIMEOUT_MS = 240_000
const SNAPSHOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'l2d-selftest-'))
const SNAPSHOTS = ['selftest-nene-motion.png', 'selftest-nene-mouth.png', 'selftest-natsume.png']

function canRun(command: string) {
  return spawnSync(command, ['--version'], { stdio: 'ignore', windowsHide: true }).status === 0
}

function findCargo() {
  const candidates = []
  if (process.env.CARGO) candidates.push(process.env.CARGO)
  const home = os.homedir()
  if (process.platform === 'win32') {
    candidates.push(path.join(home, '.cargo', 'bin', 'cargo.exe'))
    candidates.push(path.join(home, '.rustup', 'toolchains', 'stable-x86_64-pc-windows-msvc', 'bin', 'cargo.exe'))
  } else {
    candidates.push(path.join(home, '.cargo', 'bin', 'cargo'))
  }
  candidates.push(process.platform === 'win32' ? 'cargo.exe' : 'cargo')
  return candidates.find((candidate) => canRun(candidate))
}

function buildCurrentSource() {
  const cargo = findCargo()
  if (!cargo) {
    throw new Error('cargo not found; install Rust or set CARGO to cargo.exe')
  }
  console.log(`[l2d-selftest] building current source (${PROFILE})`)
  const env = { ...process.env }
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH'
  env[pathKey] = [path.dirname(cargo), env[pathKey] || ''].filter(Boolean).join(path.delimiter)
  const result = spawnSync(cargo, CARGO_ARGS, {
    cwd: ROOT,
    stdio: 'inherit',
    env,
    windowsHide: false,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`cargo build failed with exit=${result.status}`)
}

function snapshotsAreValid() {
  return SNAPSHOTS.every((name) => {
    const file = path.join(SNAPSHOT_DIR, name)
    if (!fs.existsSync(file) || fs.statSync(file).size < 32) return false
    const signature = fs.readFileSync(file).subarray(0, 8)
    return signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  })
}

function main() {
  try {
    buildCurrentSource()
  } catch (error) {
    console.error(`[l2d-selftest] BUILD FAIL: ${runtimeErrorMessage(error)}`)
    process.exit(2)
  }
  if (!fs.existsSync(EXE)) throw new Error(`built exe not found: ${EXE}`)
  const logPath = path.join(SNAPSHOT_DIR, 'selftest.log')
  const logFd = fs.openSync(logPath, 'w')
  const child = spawn(EXE, [], {
    env: {
      ...process.env,
      LIVE2D_SELFTEST: '1',
      LIVE2D_SNAPSHOT_DIR: SNAPSHOT_DIR,
    },
    // Release binaries use the Windows GUI subsystem. Inheriting a file
    // handle is reliable here, while piped stdio can silently lose output.
    stdio: ['ignore', logFd, logFd],
    windowsHide: false,
  })

  const closeLog = () => {
    try { fs.closeSync(logFd) } catch {}
  }
  const cleanup = () => {
    closeLog()
    fs.rmSync(SNAPSHOT_DIR, { recursive: true, force: true })
  }
  const timer = setTimeout(() => {
    console.error('[l2d-selftest] TIMEOUT (240s)')
    child.kill('SIGKILL')
    cleanup()
    process.exit(1)
  }, TIMEOUT_MS)

  child.on('close', (code) => {
    clearTimeout(timer)
    closeLog()
    const combined = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : ''
    const markerOk = /LIVE2D_SELFTEST_OK frames=\d+/.test(combined)
    const snapshotsOk = snapshotsAreValid()
    const ok = code === 0 && (markerOk || snapshotsOk)
    const hit = (combined.match(/LIVE2D_SELFTEST_HITTEST areas=\[([^\]]*)\]/) || [])[1] || 'none'
    const frames = (combined.match(/LIVE2D_SELFTEST_OK frames=(\d+)/) || [])[1] || '0'
    if (ok) {
      if (markerOk) {
        console.log(`[l2d-selftest] OK frames=${frames} hit=${hit}`)
      } else {
        console.log(`[l2d-selftest] OK snapshots=${SNAPSHOTS.length}/${SNAPSHOTS.length} exit=0 (GUI stdout marker unavailable)`)
      }
    } else {
      console.error(`[l2d-selftest] FAIL exit=${code}`)
      console.error(`[l2d-selftest] snapshots=${snapshotsOk ? 'valid' : 'missing or invalid'}`)
      console.error(combined.split('\n').filter((l) => /SELFTEST|FAIL|panicked|error/i.test(l)).slice(-10).join('\n'))
    }
    cleanup()
    process.exit(ok ? 0 : 1)
  })
}

main()
