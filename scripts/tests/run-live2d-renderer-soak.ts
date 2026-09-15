/**
 * Release Native renderer cache/soak gate.
 *
 * Builds the current renderer_soak example, samples the child process Working
 * Set and Windows GPU memory counters, then verifies the renderer's own cache
 * counters and frame-time summary. This is intentionally not part of the
 * default validate chain: it requires Windows, DX12 and the Cubism SDK.
 *
 * Examples:
 *   node scripts/tests/run-live2d-renderer-soak.js --seconds 30 --switch-every 5
 *   node scripts/tests/run-live2d-renderer-soak.js                 # 30 minutes
 */
'use strict'

const { spawn, spawnSync }: typeof import('child_process') = require('child_process')
const fs: typeof import('fs') = require('fs')
const os: typeof import('os') = require('os')
const path: typeof import('path') = require('path')

const ROOT = path.resolve(__dirname, '..', '..')
const MANIFEST = path.join(ROOT, 'desktop-tauri', 'native-live2d', 'Cargo.toml')
const TARGET_DIR = path.join(ROOT, 'desktop-tauri', 'native-live2d', 'target', 'l20-soak')
const EXE = path.join(
  TARGET_DIR,
  'release',
  'examples',
  process.platform === 'win32' ? 'renderer_soak.exe' : 'renderer_soak',
)

function argValue(name: string|unknown[], fallback: string) {
  const index = process.argv.findIndex((value) => value === name || value.startsWith(`${name}=`))
  if (index < 0) return fallback
  const inline = process.argv[index].slice(name.length + 1)
  return inline || process.argv[index + 1] || fallback
}

const seconds = Number(argValue('--seconds', '1800'))
const switchEvery = Number(argValue('--switch-every', '300'))
const sampleMs = Number(argValue('--sample-ms', '5000'))
const warmup = Number(argValue('--warmup', '120'))
const size = Number(argValue('--size', '800'))
const fps = Number(argValue('--fps', '165'))

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
  if (!cargo) throw new Error('cargo not found; set CARGO or install Rust')
  const args = [
    'build',
    '--release',
    '--locked',
    '--manifest-path',
    MANIFEST,
    '--example',
    'renderer_soak',
  ]
  const env = { ...process.env }
  env.CARGO_TARGET_DIR = TARGET_DIR
  delete env.CARGO_BUILD_TARGET
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH'
  env[pathKey] = [path.dirname(cargo), env[pathKey] || ''].filter(Boolean).join(path.delimiter)
  console.log('[l2d-renderer-soak] building current release source')
  const result = spawnSync(cargo, args, {
    cwd: ROOT,
    env,
    stdio: 'inherit',
    windowsHide: false,
    timeout: 300000,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`cargo build failed with exit=${result.status}`)
  if (!fs.existsSync(EXE)) throw new Error(`renderer_soak executable not found: ${EXE}`)
}

function powershellSample(pid: number|undefined) {
  const script = `
$ErrorActionPreference = 'Stop'
$targetPid = ${pid}
$p = Get-Process -Id $targetPid
$processDedicated = $null
$processShared = $null
$gpuScope = 'unavailable'
try {
  $samples = @(Get-Counter '\\GPU Process Memory(*)\\Dedicated Usage' -ErrorAction Stop).CounterSamples | Where-Object { $_.InstanceName -like "pid_\${targetPid}_*" }
  if ($samples.Count -gt 0) {
    $processDedicated = [int64](($samples | Measure-Object -Property CookedValue -Sum).Sum)
    $gpuScope = 'process'
  }
} catch {}
try {
  $samples = @(Get-Counter '\\GPU Process Memory(*)\\Shared Usage' -ErrorAction Stop).CounterSamples | Where-Object { $_.InstanceName -like "pid_\${targetPid}_*" }
  if ($samples.Count -gt 0) {
    $processShared = [int64](($samples | Measure-Object -Property CookedValue -Sum).Sum)
    $gpuScope = 'process'
  }
} catch {}
[pscustomobject]@{
  pid = $targetPid
  workingSetBytes = [int64]$p.WorkingSet64
  privateBytes = [int64]$p.PrivateMemorySize64
  gpuDedicatedBytes = $processDedicated
  gpuSharedBytes = $processShared
  gpuScope = $gpuScope
} | ConvertTo-Json -Compress
`
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', windowsHide: true },
  )
  if (result.status !== 0) return null
  const text = String(result.stdout || '').trim()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function average(values: unknown[]) {
  if (!values.length) return null
  return values.reduce((sum: any, value: any) => sum + value, 0) / values.length
}

function trend(samples: unknown[], field: string) {
  const values = samples.filter((sample: { [x: string]: unknown }) => Number.isFinite(sample[field]))
  if (values.length < 4) return null
  const quarter = Math.max(1, Math.floor(values.length / 4))
  const first = average(values.slice(0, quarter).map((sample: { [x: string]: unknown }) => sample[field]))
  const last = average(values.slice(-quarter).map((sample: { [x: string]: unknown }) => sample[field]))
  const meanT = average(values.map((sample: any) => sample.t))
  const meanV = average(values.map((sample: { [x: string]: unknown }) => sample[field]))
  let numerator = 0
  let denominator = 0
  for (const sample of values) {
    numerator += (sample.t - meanT) * (sample[field] - meanV)
    denominator += (sample.t - meanT) ** 2
  }
  return {
    count: values.length,
    firstQuarterAvg: first,
    lastQuarterAvg: last,
    deltaBytes: last - first,
    slopeBytesPerMinute: denominator === 0 ? 0 : (numerator / denominator) * 60000,
    min: Math.min(...values.map((sample: { [x: string]: unknown }) => sample[field])),
    max: Math.max(...values.map((sample: { [x: string]: unknown }) => sample[field])),
  }
}

function parseSummary(output: string) {
  const matches = [...output.matchAll(/L2D_SOAK_SUMMARY\s+(\{.*\})/g)]
  if (!matches.length) return null
  try {
    return JSON.parse(matches[matches.length - 1][1])
  } catch {
    return null
  }
}

function runRenderer() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'l2d-renderer-soak-'))
  const logPath = path.join(tempDir, 'renderer-soak.log')
  const log = fs.createWriteStream(logPath, { encoding: 'utf8' })
  const assetsRoot = path.join(ROOT, 'assets', 'live2d')
  const args = [
    '--assets-root',
    assetsRoot,
    '--seconds',
    String(seconds),
    '--warmup',
    String(warmup),
    '--switch-every',
    String(switchEvery),
    '--size',
    String(size),
    '--fps',
    String(fps),
  ]
  const childEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('L2D_')),
  )
  childEnv.WGPU_BACKEND = 'dx12'
  const child = spawn(EXE, args, {
    cwd: ROOT,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  })
  let output = ''
  const append = (chunk: unknown) => {
    const text = String(chunk)
    output += text
    log.write(text)
    process.stdout.write(text)
  }
  child.stdout.on('data', append)
  child.stderr.on('data', append)

  const samples: unknown[] = []
  const sample = () => {
    const value = powershellSample(child.pid)
    if (value) samples.push({ t: Date.now(), ...value })
  }
  const sampler = setInterval(sample, Math.max(1000, sampleMs))
  sample()

  const timeout = setTimeout(() => {
    console.error(`[l2d-renderer-soak] TIMEOUT after ${seconds}s`)
    child.kill('SIGKILL')
  }, (seconds + 120) * 1000)

  return new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code, signal) => {
      clearInterval(sampler)
      clearTimeout(timeout)
      sample()
      log.end()
      resolve({ code, signal, output, samples, logPath })
    })
  })
}

function validate(result: any) {
  const summary = parseSummary(result.output)
  if (result.code !== 0) throw new Error(`renderer_soak exit=${result.code} signal=${result.signal || 'none'}`)
  if (!summary) throw new Error(`missing L2D_SOAK_SUMMARY; log=${result.logPath}`)
  const expectedSwitches = Math.floor((seconds - 0.001) / switchEvery)
  if (summary.model_switches < expectedSwitches || expectedSwitches < 1) {
    throw new Error(
      `insufficient model switches=${summary.model_switches}, expected>=${expectedSwitches}; log=${result.logPath}`,
    )
  }
  if (summary.warmup_frame_creations !== 0) {
    throw new Error(`warmup created resources=${summary.warmup_frame_creations}; log=${result.logPath}`)
  }
  if (summary.final_frame_creations !== 0) {
    throw new Error(`final frame created resources=${summary.final_frame_creations}; log=${result.logPath}`)
  }
  if (summary.all_switches_stable !== true) {
    throw new Error(`model switch cache did not settle; log=${result.logPath}`)
  }
  if (summary.resources_released !== true || summary.release_checks < summary.model_switches + 1) {
    throw new Error(`model resources were not released for every switch/destroy; log=${result.logPath}`)
  }
  if (summary.backend !== 'Dx12') {
    throw new Error(`renderer soak used ${summary.backend || 'unknown'} instead of Dx12; log=${result.logPath}`)
  }
  if (!Number.isFinite(summary.p50_ms) || !Number.isFinite(summary.p95_ms) || !Number.isFinite(summary.render_fps)) {
    throw new Error(`invalid frame timing summary; log=${result.logPath}`)
  }
  if (summary.min_draw_calls <= 0 || summary.min_total_vertices <= 0) {
    throw new Error(`renderer produced an empty workload; log=${result.logPath}`)
  }
  const effectiveSeconds = Math.max(1, seconds - Number(summary.model_load_s || 0))
  const minimumFrames = Math.floor(effectiveSeconds * fps * 0.8)
  if (summary.frames < minimumFrames || summary.render_fps < fps * 0.8) {
    throw new Error(
      `insufficient render work frames=${summary.frames}/${minimumFrames} ` +
      `renderFps=${summary.render_fps.toFixed(1)}; log=${result.logPath}`,
    )
  }
  const resourceCounters = Object.values(summary.resources || {})
  if (!resourceCounters.length || resourceCounters.some((value: any) => !Number.isInteger(value) || value < 0)) {
    throw new Error(`invalid resource creation counters; log=${result.logPath}`)
  }
  const countedCreations = resourceCounters.reduce((sum: any, value: any) => sum + value, 0)
  if (countedCreations !== summary.total_creations) {
    throw new Error(
      `resource counter mismatch total=${summary.total_creations} counted=${countedCreations}; log=${result.logPath}`,
    )
  }
  if (!result.samples.some((sample: any) => Number.isFinite(sample.workingSetBytes))) {
    throw new Error(`no Working Set samples; log=${result.logPath}`)
  }
  const gpuSamples = result.samples.filter((sample: { gpuScope: string }) => sample.gpuScope === 'process')
  const minimumGpuSamples = seconds >= 60 ? 4 : 2
  const dedicatedSamples = gpuSamples.filter((sample: any) => Number.isFinite(sample.gpuDedicatedBytes))
  const sharedSamples = gpuSamples.filter((sample: any) => Number.isFinite(sample.gpuSharedBytes))
  if (dedicatedSamples.length < minimumGpuSamples || sharedSamples.length < minimumGpuSamples) {
    throw new Error(`GPU dedicated/shared counters unavailable; log=${result.logPath}`)
  }

  const report: any = {
    summary,
    sampleCount: result.samples.length,
    gpuSampleCount: gpuSamples.length,
    gpuScopes: [...new Set(gpuSamples.map((sample: any) => sample.gpuScope))],
    workingSet: trend(result.samples, 'workingSetBytes'),
    privateBytes: trend(result.samples, 'privateBytes'),
    gpuDedicated: trend(result.samples, 'gpuDedicatedBytes'),
    gpuShared: trend(result.samples, 'gpuSharedBytes'),
    logPath: result.logPath,
  }
  const firstSampleTime = result.samples[0] ? result.samples[0].t : 0
  const steadyStart = firstSampleTime + (switchEvery * 2 + 10) * 1000
  const steadySamples = result.samples
    .filter((sample: { t: number }) => sample.t >= steadyStart)
    .map((sample: any) => ({
      ...sample,
      gpuTotalBytes: Number.isFinite(sample.gpuDedicatedBytes) && Number.isFinite(sample.gpuSharedBytes)
        ? sample.gpuDedicatedBytes + sample.gpuSharedBytes
        : null,
    }))
  report.steadySampleCount = steadySamples.length
  report.steadyWorkingSet = trend(steadySamples, 'workingSetBytes')
  report.steadyPrivateBytes = trend(steadySamples, 'privateBytes')
  report.steadyGpuTotal = trend(steadySamples, 'gpuTotalBytes')
  const reportPath = path.join(path.dirname(result.logPath), 'renderer-soak-report.json')
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

  if (seconds >= 300) {
    if (steadySamples.length < 8) {
      throw new Error(`insufficient post-warmup memory samples=${steadySamples.length}; report=${reportPath}`)
    }
    const memoryChecks = [
      ['Working Set', report.steadyWorkingSet],
      ['private bytes', report.steadyPrivateBytes],
      ['GPU total', report.steadyGpuTotal],
    ]
    for (const [name, stats] of memoryChecks) {
      if (!stats) throw new Error(`${name} post-warmup samples unavailable; report=${reportPath}`)
      const deltaLimit = name === 'Working Set' ? 64 : 128
      const slopeLimit = name === 'Working Set' ? 2 : 8
      const deltaMiB = stats.deltaBytes / 1024 / 1024
      const slopeMiBPerMinute = stats.slopeBytesPerMinute / 1024 / 1024
      if (deltaMiB > deltaLimit && slopeMiBPerMinute > slopeLimit) {
        throw new Error(
          `${name} has a sustained upward trend: delta=${deltaMiB.toFixed(1)}MiB ` +
          `slope=${slopeMiBPerMinute.toFixed(2)}MiB/min; report=${reportPath}`,
        )
      }
    }
  }
  console.log(`[l2d-renderer-soak] PASS report=${reportPath}`)
  console.log(
    `[l2d-renderer-soak] frames=${summary.frames} p50=${summary.p50_ms.toFixed(3)}ms ` +
    `p95=${summary.p95_ms.toFixed(3)}ms renderFps=${summary.render_fps.toFixed(1)} ` +
    `switches=${summary.model_switches} ` +
    `gpuScopes=${report.gpuScopes.join(',')}`,
  )
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Native renderer soak requires Windows DX12')
  if (![seconds, switchEvery, sampleMs, warmup, size, fps].every(Number.isFinite)) {
    throw new Error('invalid numeric argument')
  }
  if (seconds <= 0 || switchEvery <= 0 || switchEvery >= seconds || sampleMs <= 0 || warmup < 0 || size <= 0 || fps <= 0) {
    throw new Error('seconds/sample-ms/size/fps must be positive and switch-every must be within the run')
  }
  buildCurrentSource()
  const result = await runRenderer()
  validate(result)
}

main().catch((error) => {
  console.error(`[l2d-renderer-soak] FAIL: ${error.message}`)
  process.exitCode = 1
})
