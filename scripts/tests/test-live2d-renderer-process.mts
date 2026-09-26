import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import sharp from 'sharp'

const require = createRequire(import.meta.url)
const windows = require('./desktop-native/windows.js') as typeof import('./desktop-native/windows.js')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const { values } = parseArgs({ options: {
  exe: { type: 'string' }, 'assets-root': { type: 'string' }, out: { type: 'string' },
  'sample-ms': { type: 'string', default: '2000' }, help: { type: 'boolean' },
} })
if (values.help) {
  console.log('Windows isolated GPU acceptance: --exe <built candidate> --assets-root <existing assets> --out <new evidence directory> [--sample-ms 2000]')
  process.exit(0)
}
assert.equal(process.platform, 'win32', 'This acceptance runner requires Windows and a local GPU')
for (const key of ['exe', 'assets-root', 'out'] as const) assert.ok(values[key], `Missing --${key}`)
const exe = fs.realpathSync(path.resolve(values.exe!))
const assetsRoot = fs.realpathSync(path.resolve(values['assets-root']!))
const out = path.resolve(values.out!)
const sampleMs = Number(values['sample-ms'])
assert.ok(Number.isInteger(sampleMs) && sampleMs >= 500 && sampleMs <= 10_000, '--sample-ms must be 500..10000')
assert.ok(!fs.existsSync(out), '--out must be a new directory so earlier evidence is preserved')
if (path.basename(path.dirname(assetsRoot)).toLowerCase() === 'gateway') {
  assert.ok(!exe.toLowerCase().startsWith(path.resolve(assetsRoot, '../..').toLowerCase() + path.sep), 'Use a built candidate, not the installed production executable')
}
fs.mkdirSync(out, { recursive: true })
const hash = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const report: Record<string, any> = {
  schemaVersion: 1, startedAt: new Date().toISOString(), status: 'running',
  executable: { path: exe, sha256: hash(exe) }, assetsRoot, sampleMs,
  productionProfileAccessed: false, installedApplicationStarted: false, aiGenerationInvoked: false,
  environment: { platform: process.platform, arch: process.arch, node: process.version },
  models: [], checks: [], visualReview: 'required: inspect the GPU snapshot PNGs; state and frame counts alone do not prove appearance',
}
const saveReport = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n')
saveReport()
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
async function until<T>(work: () => T | Promise<T>, accepts: (value: T) => boolean, label: string, timeout = 10_000): Promise<T> {
  const deadline = performance.now() + timeout
  do { const value = await work(); if (accepts(value)) return value; await delay(40) } while (performance.now() < deadline)
  throw new Error(`Timed out: ${label}`)
}
async function gone(pid: number) { await until(() => alive(pid), value => !value, `process ${pid} exit`) }
type Pending = { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }
class Probe {
  process: ChildProcessWithoutNullStreams
  pending = new Map<number, Pending>()
  events: any[] = []
  pids = new Set<number>()
  nextId = 0
  buffer = ''
  closed: Promise<void>
  readonly name: string
  constructor(name: string) {
    this.name = name
    const fixture = path.join(out, name)
    for (const dir of ['config', 'profile']) fs.mkdirSync(path.join(fixture, dir), { recursive: true })
    this.process = spawn(exe, ['--live2d-renderer-probe-host'], {
      cwd: fixture, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, AICS_LIVE2D_RENDERER_PROCESS: '1',
        AICS_DESKTOP_CONFIG_ROOT: path.join(fixture, 'config'), AICS_DESKTOP_WEBVIEW_DATA_DIR: path.join(fixture, 'profile') },
    })
    const log = (kind: string, value: string) => fs.appendFileSync(path.join(fixture, kind), value)
    this.process.stdout.setEncoding('utf8')
    this.process.stdout.on('data', (chunk: string) => {
      log('protocol.jsonl', chunk); this.buffer += chunk
      try {
        let end: number
        while ((end = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1)
          assert.ok(Buffer.byteLength(line) <= 65_536, 'Oversized JSONL reply')
          const message = JSON.parse(line)
          if (message.type === 'event') { this.events.push(message); continue }
          assert.equal(message.type, 'reply')
          const pending = this.pending.get(message.id)
          assert.ok(pending, `Unexpected reply ${message.id}`)
          clearTimeout(pending.timer); this.pending.delete(message.id)
          if ('Ok' in message.result) pending.resolve(message.result.Ok)
          else pending.reject(new Error(message.result.Err))
        }
        assert.ok(Buffer.byteLength(this.buffer) <= 65_536, 'Oversized incomplete JSONL reply')
      } catch (error) { this.rejectAll(error as Error); this.process.kill() }
    })
    this.process.stderr.on('data', chunk => log('stderr.log', String(chunk)))
    this.process.on('error', error => this.rejectAll(error))
    this.closed = new Promise(resolve => this.process.once('close', (code, signal) => {
      this.rejectAll(new Error(`Probe closed (${code ?? signal})`))
      log('exit.json', JSON.stringify({ code, signal }) + '\n'); resolve()
    }))
  }
  rejectAll(error: Error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
  }
  request(op: string, args: Record<string, unknown> = {}, timeout = 40_000): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${this.name}: ${op} runner timeout`)) }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      const line = JSON.stringify({ id, op, ...args }) + '\n'
      assert.ok(Buffer.byteLength(line) <= 65_536)
      this.process.stdin.write(line, error => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(error) } })
    })
  }
  async start() {
    const state = await this.request('start', { assets_root: assetsRoot, local_root: null })
    assert.equal(state.alive, true); assert.ok(state.childPid && state.childPid !== this.process.pid)
    this.pids.add(state.childPid); return state
  }
  async call(command: Record<string, unknown>, timeout = 30_000) {
    const result = await this.request('call', { command, timeout_ms: timeout }, timeout + 5000)
    return result.value
  }
  async exit(op: 'exit' | 'abandon' | 'eof') {
    if (op === 'eof') this.process.stdin.end()
    else await this.request(op)
    await until(() => this.process.exitCode !== null || this.process.signalCode !== null, value => value, `${op}: parent exit`)
    await this.closed
    assert.equal(this.process.exitCode, 0, `${op}: parent exit code`)
    for (const pid of this.pids) await gone(pid)
  }
  async cleanup() {
    if (this.process.exitCode === null && this.process.signalCode === null) this.process.kill()
    await Promise.race([this.closed, delay(5000, undefined, { ref: false })])
    // Cleanup of this runner's remaining child is not accepted as an orphan test pass.
    for (const pid of this.pids) if (alive(pid)) process.kill(pid)
  }
}

const probes: Probe[] = []
const probe = (name: string) => { const value = new Probe(name); probes.push(value); return value }
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  void (async () => {
    report.status = 'interrupted'; report.error = signal
    for (const host of probes) await host.cleanup()
    report.finishedAt = new Date().toISOString(); saveReport(); process.exit(signal === 'SIGINT' ? 130 : 143)
  })()
})
// Import the production compiler at runtime so this Node-only runner never emits frontend sources.
const profiles = await import(pathToFileURL(path.join(root, 'src/live2d/adapterProfile.ts')).href)
function characterCommand(character: 'nene' | 'natsume') {
  const compiled = profiles.compileAdapterProfile(character === 'nene' ? profiles.NENE_BUILTIN_PROFILE : profiles.NATSUME_BUILTIN_PROFILE, 'native')
  assert.equal(compiled.ok, true, `Production adapter ${character} must compile`)
  return { type: 'setCharacter', character, texture_scale: 1, adapter: compiled.adapter }
}
const frame = { type: 'setFrame', rect: { x: 100, y: 100, width: 600, height: 800 }, visible: true, opacity: 255, framing: null, companion_hwnd: null }
async function loadModel(host: Probe, character: 'nene' | 'natsume') {
  const eventsBefore = host.events.length
  await host.call(characterCommand(character))
  assert.ok(host.events.slice(eventsBefore).some(event => event.name === 'aics:live2d:ready'), 'Model ready event must reach parent')
  if (character === 'nene') await host.call({ type: 'setExpression', name: 'expression1' })
  await host.call(frame)
  return until(() => host.call({ type: 'getState' }), state => state.ready && state.visible && state.windowReady && state.rendererAttached && state.frameCount > 0, `${character} visible frames`)
}
async function snapshot(host: Probe, character: string) {
  const file = path.join(out, `${character}-gpu.png`)
  await host.call({ type: 'snapshot', path: file })
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let opaquePixels = 0
  for (let i = 3; i < data.length; i += 4) if (data[i]! > 16) opaquePixels++
  assert.equal(info.width, 800); assert.equal(info.height, 800)
  assert.ok(opaquePixels > 6400, `${character}: GPU readback has too little visible content`)
  return { path: file, sha256: hash(file), width: info.width, height: info.height, opaquePixels, source: 'renderer GPU readback; visual review required' }
}
function check(name: string, details: Record<string, unknown>) {
  report.checks.push({ name, passed: true, ...details }); saveReport(); console.log(`PASS ${name}`)
}
try {
  report.environment.native = windows.collectEnvironment()
  const host = probe('render-and-recover')
  const initial = await host.start()
  for (const character of ['nene', 'natsume'] as const) {
    console.log(`Loading ${character}`)
    const modelFile = path.join(assetsRoot, 'live2d', character, `${character}.model3.json`)
    const ready = await loadModel(host, character)
    const samples = []
    for (const fps of [60, 120, 165]) {
      await host.call({ type: 'setMaxFps', fps }); await delay(400)
      const before = await host.call({ type: 'getState' }); const started = performance.now()
      await delay(sampleMs)
      const after = await host.call({ type: 'getState' }); const elapsedMs = performance.now() - started
      assert.equal(after.targetFps, fps); assert.ok(after.frameCount > before.frameCount, `${character} at ${fps} FPS stopped rendering`)
      assert.equal(after.renderErrors, before.renderErrors, `${character} render error during measurement`)
      const frameDelta = after.frameCount - before.frameCount
      samples.push({ requestedFps: fps, elapsedMs, frameDelta, measuredFps: frameDelta * 1000 / elapsedMs, surfaceFailures: after.surfaceFailures, surfaceRecoveries: after.surfaceRecoveries })
    }
    const image = await snapshot(host, character)
    const ownedWindows = windows.windowsForProcess(initial.childPid)
    assert.ok(ownedWindows.some((window: any) => window.Visible && window.Title === 'aics-live2d-overlay'), 'Renderer child must own a visible overlay window')
    report.models.push({ character, modelFile, modelSha256: hash(modelFile), textureScale: 1,
      defaultOutfit: character === 'nene' ? 'school/expression1' : 'natsume-cafe', ready, samples, image, ownedWindows,
      resources: windows.sampleProcessTree(host.process.pid),
    }); saveReport()
  }
  check('both built-in models render at each requested frame limit', { parentPid: host.process.pid, childPid: initial.childPid })

  // Loading real texture data supplies a meaningful pending request while the independent parent stays responsive.
  const pendingLoad = host.call(characterCommand('nene')).then(() => ({ rejected: false, error: '' }), error => ({ rejected: true, error: String(error) }))
  await until(() => host.request('status'), state => state.pending > 0, 'parent sees pending model load')
  await host.request('kill')
  const rejected = await pendingLoad
  assert.equal(rejected.rejected, true, 'Killing renderer must reject its pending call')
  await gone(initial.childPid)
  const dead = await host.request('status')
  assert.equal(dead.alive, false); assert.equal(dead.pending, 0); assert.equal(host.process.exitCode, null)
  await assert.rejects(host.call({ type: 'getState' }), /explicit|stopp|terminat|attach|exit/i)
  const stillDead = await host.request('status')
  assert.equal(stillDead.generation, dead.generation); assert.equal(stillDead.alive, false)
  const reconnected = await host.start()
  assert.notEqual(reconnected.childPid, initial.childPid); assert.ok(reconnected.generation > initial.generation)
  await loadModel(host, 'natsume')
  check('kill rejects pending; parent survives; explicit reconnect renders', { rejected, before: initial, afterKill: dead, reconnected })

  // A real long operation with a short deadline exercises supervisor cancellation, not a fake sleep command.
  await assert.rejects(host.call(characterCommand('nene'), 1), /timed? ?out|timeout/i)
  const timedOut = await host.request('status')
  assert.equal(timedOut.alive, false); assert.equal(timedOut.pending, 0)
  await gone(reconnected.childPid)
  check('deadline closes failed generation without implicit restart', { status: timedOut })
  const finalChild = await host.start()
  await host.call({ type: 'shutdown' })
  await gone(finalChild.childPid)
  await host.exit('exit')
  check('renderer Shutdown and normal parent exit leave no child', { childPid: finalChild.childPid })

  for (const mode of ['eof', 'abandon'] as const) {
    const parent = probe(`parent-${mode}`); const child = await parent.start()
    await parent.exit(mode)
    check(mode === 'eof' ? 'parent stdin EOF gracefully reaps child' : 'abrupt parent exit triggers OS Job child cleanup', { parentPid: parent.process.pid, childPid: child.childPid })
  }
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'; report.error = String(error); process.exitCode = 1
  console.error(error)
} finally {
  for (const host of probes) await host.cleanup()
  report.finishedAt = new Date().toISOString(); saveReport()
  console.log(`Evidence: ${path.join(out, 'report.json')}`)
}
