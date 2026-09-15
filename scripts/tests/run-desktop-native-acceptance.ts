#!/usr/bin/env node
import { errorMessage as runtimeErrorMessage, errorStack as runtimeErrorStack } from '../lib/runtime-errors';
'use strict'

const fs: typeof import('node:fs') = require('node:fs')
const http: typeof import('node:http') = require('node:http')
const os: typeof import('node:os') = require('node:os')
const path: typeof import('node:path') = require('node:path')
const { spawnSync }: typeof import('node:child_process') = require('node:child_process')
const wavQuality: typeof import('../lib/wav-quality') = require('../lib/wav-quality')
const {
  findExecutable,
  installerMetadata,
  locateInstaller,
  runCommand,
  sha256File,
}: typeof import('./desktop-native/command') = require('./desktop-native/command')
const {
  createIsolatedFixture,
  mutateSourceFixture,
  removeFixture,
  safetyFailureInjection,
  snapshotFiles,
  verifyMigration,
  verifySourceSnapshot,
}: typeof import('./desktop-native/fixtures') = require('./desktop-native/fixtures')
const { startMockOpenAi }: typeof import('./desktop-native/mock-openai') = require('./desktop-native/mock-openai')
const {
  Evidence,
  atomicWrite,
  now,
  readJson,
  resolveAiWorkspace,
  writeJson,
}: typeof import('./desktop-native/report') = require('./desktop-native/report')
const { TauriDriver, delay, freePort }: typeof import('./desktop-native/webdriver') = require('./desktop-native/webdriver')
const {
  captureDesktop,
  collectEnvironment,
  findUninstallEntry,
  findWindow,
  portOwner,
  processTree,
  processesByExecutable,
  sampleProcessTree,
  sendClick,
  sendToggleVisibilityHotkey,
  setWindowRect,
  terminateOwnedPids,
  windowsForProcess,
}: typeof import('./desktop-native/windows') = require('./desktop-native/windows')

const ROOT = path.resolve(__dirname, '..', '..')
const BUILD_RECORD = 'installer-build.json'
const INSTALLER_HASH = 'installer.sha256'
const REQUIRED_DPI = ['100', '125', '150']

function parseArgs(argv: any) {
  const output = { positional: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--') {
      output.positional.push(...argv.slice(index + 1))
      break
    }
    if (!value.startsWith('--')) {
      output.positional.push(value)
      continue
    }
    const equal = value.indexOf('=')
    const key = equal >= 0 ? value.slice(2, equal) : value.slice(2)
    const inline = equal >= 0 ? value.slice(equal + 1) : null
    const next = inline ?? (argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : true)
    output[key] = next
  }
  return output
}

function commandVersion(executable: any, args = ['--version']) {
  if (!executable) return null
  const result = spawnSync(executable, args, { encoding: 'utf8', windowsHide: true, timeout: 20_000 })
  if (result.status !== 0) return null
  return String(result.stdout || result.stderr || '').trim()
}

function cargoInstalledVersion(executable: any, packageName: any) {
  if (!executable) return null
  const manifest = path.join(path.dirname(path.dirname(path.resolve(executable))), '.crates.toml')
  if (!fs.existsSync(manifest)) return null
  const prefix = `"${packageName} `
  const line = fs.readFileSync(manifest, 'utf8').split(/\r?\n/u).find(value => value.startsWith(prefix))
  return line?.slice(prefix.length).split(' ')[0] || null
}

function npmInvocation(args: any) {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
  ].filter(Boolean)
  const cli = candidates.find(candidate => fs.existsSync(candidate))
  if (!cli) throw new Error('npm CLI could not be located')
  return { command: process.execPath, args: [cli, ...args] }
}

function resolveRecordedInvocation(command: any, args: any) {
  const normalized = command.toLowerCase().replace(/\.cmd$/u, '').replace(/\.exe$/u, '')
  if (normalized === 'npm') return npmInvocation(args)
  if (normalized === 'cargo') {
    const cargo = findExecutable('cargo', [process.env.CARGO])
    if (!cargo) throw new Error('cargo could not be located')
    return { command: cargo, args }
  }
  return { command, args }
}

function gitValue(args: any) {
  const result = spawnSync('git.exe', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) return null
  return String(result.stdout || '').trim()
}

function freezeSnapshot() {
  return {
    capturedAt: now(),
    head: gitValue(['rev-parse', 'HEAD']),
    diffNames: String(gitValue(['diff', '--name-only', 'HEAD']) || '').split(/\r?\n/u).filter(Boolean),
    stagedDiffNames: String(gitValue(['diff', '--cached', '--name-only']) || '').split(/\r?\n/u).filter(Boolean),
    worktreeStatus: String(gitValue(['status', '--porcelain=v1', '-uall']) || '').split(/\r?\n/u).filter(Boolean),
  }
}

function writeInstallerRecord(evidence: any, metadata: any, freeze: any) {
  evidence.beginInstallerCycle(metadata, freeze)
  const record = { recordedAt: now(), freeze, installer: metadata }
  writeJson(path.join(evidence.directory, BUILD_RECORD), record)
  atomicWrite(
    path.join(evidence.directory, INSTALLER_HASH),
    `${metadata.sha256}  ${path.basename(metadata.path)}\n`,
  )
  evidence.artifact('installerBuild', path.join(evidence.directory, BUILD_RECORD))
  evidence.artifact('installerSha256', path.join(evidence.directory, INSTALLER_HASH))
}

async function recordCommand(args: any) {
  const evidence = new Evidence({ root: ROOT, directory: args['evidence-dir'] })
  if (!args.positional.length) throw new Error('--record-command requires a command after --')
  const [displayCommand, ...displayArgs] = args.positional
  const invocation = resolveRecordedInvocation(displayCommand, displayArgs)
  const isPackage = displayCommand.toLowerCase().startsWith('npm')
    && displayArgs[0] === 'run'
    && displayArgs[1] === 'package:tauri'
  const freeze = isPackage ? freezeSnapshot() : null
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'PATH'
  const cargo = findExecutable('cargo', [process.env.CARGO])
  const environment = {
    ...process.env,
    [pathKey]: [cargo ? path.dirname(cargo) : '', process.env[pathKey] || ''].filter(Boolean).join(path.delimiter),
  }
  const result = await runCommand(invocation.command, invocation.args, {
    cwd: ROOT,
    env: environment,
    evidence,
    display: [displayCommand, ...displayArgs].join(' '),
    timeoutMs: isPackage ? 90 * 60_000 : 45 * 60_000,
    windowsHide: false,
  })
  if (result.code === 0 && isPackage) {
    const installer = locateInstaller(ROOT)
    if (!installer) throw new Error('package:tauri succeeded but no NSIS installer was found')
    writeInstallerRecord(evidence, installerMetadata(ROOT, installer), freeze)
  }
  evidence.result(`command:${[displayCommand, ...displayArgs].join(' ')}`, result.code === 0 ? 'PASS' : 'FAIL', {
    exitCode: result.code,
    durationMs: result.durationMs,
  })
  evidence.finalize(result.code === 0 ? 'IN_PROGRESS' : 'FAIL')
  process.exitCode = result.code
}

function httpRequest(url: any, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const request = http.request(target, {
      method: options.method || 'GET',
      headers: options.headers || {},
    }, response => {
      const chunks: any = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode || 0, headers: response.headers, body: Buffer.concat(chunks) }))
    })
    request.setTimeout(options.timeoutMs || 10_000, () => request.destroy(new Error(`request timed out: ${url}`)))
    request.on('error', reject)
    request.end(options.body)
  })
}

async function waitFor(description: any, predicate: any, timeoutMs = 30_000, intervalMs = 100) {
  const started = Date.now()
  let lastError = null
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await predicate()
      if (value) return { value, elapsedMs: Date.now() - started }
    } catch (error) {
      lastError = error
    }
    await delay(intervalMs)
  }
  throw new Error(`Timed out waiting for ${description}; last=${lastError?.message || 'false'}`)
}

function driverCandidates(name: any) {
  const temporaryTools = path.join(os.tmpdir(), 'opencode', 'd10-tools')
  return name === 'tauri-driver'
    ? [process.env.D10_TAURI_DRIVER, path.join(temporaryTools, 'bin', 'tauri-driver.exe')]
    : [process.env.D10_MSEDGEDRIVER, path.join(temporaryTools, 'msedgedriver.exe')]
}

function versionNumber(text: any) {
  return String(text || '').match(/\d+\.\d+\.\d+\.\d+/u)?.[0] || null
}

function verifyBuildRecord(evidence: any, installerPath: any) {
  const recordPath = path.join(evidence.directory, BUILD_RECORD)
  const record = readJson(recordPath, null)
  if (!record?.installer) throw new Error(`missing package build record: ${recordPath}`)
  const current = installerMetadata(ROOT, installerPath)
  const mismatches = []
  if (current.sha256 !== record.installer.sha256) mismatches.push('installer SHA-256 changed')
  if (current.packagingFingerprint.sha256 !== record.installer.packagingFingerprint?.sha256) {
    mismatches.push('packaging inputs changed after the installer was recorded')
  }
  if (mismatches.length) throw new Error(mismatches.join('; '))
  evidence.setInstaller(current)
  evidence.setFreeze(record.freeze)
  return current
}

function recordWorkflowEvidence(evidence: any, args: any) {
  const supplied = {
    url: args['workflow-url'] === true ? '' : String(args['workflow-url'] || process.env.D10_WORKFLOW_URL || '').trim(),
    runId: args['workflow-run-id'] === true ? '' : String(args['workflow-run-id'] || process.env.D10_WORKFLOW_RUN_ID || '').trim(),
    commitSha: args['workflow-commit-sha'] === true ? '' : String(args['workflow-commit-sha'] || process.env.D10_WORKFLOW_COMMIT_SHA || '').trim().toLowerCase(),
    conclusion: args['workflow-conclusion'] === true ? '' : String(args['workflow-conclusion'] || process.env.D10_WORKFLOW_CONCLUSION || '').trim().toLowerCase(),
  }
  const suppliedAny = Object.values(supplied).some(Boolean)
  if (!suppliedAny) {
    const workflow = evidence.report.workflow
    const complete = workflow?.status === 'PASS'
      && workflow.url
      && workflow.runId
      && /^[0-9a-f]{40}$/u.test(String(workflow.commitSha || ''))
    evidence.result('workflow-self-hosted', complete ? 'PASS' : 'BLOCKED', complete
      ? workflow
      : { reason: workflow?.reason || 'No self-hosted workflow URL/run id/commit SHA was supplied.' })
    return complete
  }

  const missing = Object.entries(supplied).filter(([, value]) => !value).map(([key]) => key)
  if (missing.length) throw new Error(`self-hosted workflow evidence is incomplete: missing ${missing.join(', ')}`)
  if (!/^\d+$/u.test(supplied.runId)) throw new Error(`self-hosted workflow run id is invalid: ${supplied.runId}`)
  if (!/^[0-9a-f]{40}$/u.test(supplied.commitSha)) throw new Error('self-hosted workflow commit SHA must contain 40 hexadecimal characters')
  let workflowUrl
  try {
    workflowUrl = new URL(supplied.url)
  } catch {
    throw new Error(`self-hosted workflow URL is invalid: ${supplied.url}`)
  }
  const runPath = new RegExp(`/actions/runs/${supplied.runId}(?:/|$)`, 'u')
  if (workflowUrl.protocol !== 'https:' || workflowUrl.hostname !== 'github.com' || !runPath.test(workflowUrl.pathname)) {
    throw new Error('self-hosted workflow URL must be a github.com HTTPS Actions run URL containing the supplied run id')
  }
  if (supplied.conclusion !== 'success' && supplied.conclusion !== 'pass') {
    throw new Error(`self-hosted workflow did not conclude successfully: ${supplied.conclusion}`)
  }
  const frozenHead = String(evidence.report.freeze?.head || '').toLowerCase()
  if (frozenHead && supplied.commitSha !== frozenHead) {
    throw new Error(`self-hosted workflow commit ${supplied.commitSha} does not match frozen installer HEAD ${frozenHead}`)
  }
  const workflow = {
    status: 'PASS',
    url: workflowUrl.toString(),
    runId: supplied.runId,
    commitSha: supplied.commitSha,
    conclusion: 'success',
    recordedAt: now(),
    reason: null,
  }
  evidence.setWorkflow(workflow)
  evidence.result('workflow-self-hosted', 'PASS', workflow)
  return true
}

function currentDpiLabel(args: any, environment: any) {
  const primary = environment.displays.find((display: any) => display.primary) || environment.displays[0]
  const actual = String(primary?.scalePercent || '')
  const requested = args['dpi-label'] === true || args['dpi-label'] == null ? actual : String(args['dpi-label']).replace('%', '')
  if (!actual) throw new Error('primary display DPI could not be measured')
  if (requested !== actual) throw new Error(`DPI label mismatch: requested ${requested}%, measured ${actual}%`)
  return { label: requested, primary }
}

function markDownstreamBlocked(evidence: any, reason: any) {
  for (const id of [
    'install', 'migration', 'cold-start', 'hidden-start', 'lifecycle', 'characters', 'overlay-rect',
    'move-resize', 'hide-frame-stop', 'click-motion', 'emotion-no-voice', 'fps-30-165',
    'tts-real', 'soak-300s', 'normal-exit', 'uninstall',
  ]) {
    evidence.result(id, 'BLOCKED', { reason })
  }
}

function setMatrixResult(evidence: any, section: any, key: any, status: any) {
  if (status === 'BLOCKED' && evidence.report.matrix[section]?.[key] === 'PASS') return
  evidence.setMatrix(section, key, status)
}

function installedExecutable(installLocation: any) {
  const candidates = [
    path.join(installLocation, 'ai-cg-studio-desktop.exe'),
    path.join(installLocation, 'AI-CG-Studio.exe'),
  ]
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate
  if (!fs.existsSync(installLocation)) return null
  return fs.readdirSync(installLocation)
    .filter(name => /\.exe$/iu.test(name) && !/uninstall|node/iu.test(name))
    .map(name => path.join(installLocation, name))[0] || null
}

function buildResourceManifest(installLocation: any) {
  const required = [
    'gateway/server.js',
    'node.exe',
    'gateway/dist',
    'gateway/assets/live2d/nene',
    'gateway/assets/live2d/natsume',
  ]
  const items = required.map(relative => {
    const target = path.join(installLocation, relative)
    const exists = fs.existsSync(target)
    return {
      relative,
      exists,
      type: exists ? (fs.statSync(target).isDirectory() ? 'directory' : 'file') : null,
      sha256: exists && fs.statSync(target).isFile() ? sha256File(target) : null,
    }
  })
  return { installLocation, items, ok: items.every(item => item.exists) }
}

async function installProduct(evidence: any, installer: any) {
  const before = findUninstallEntry()
  if (before.length) throw new Error(`an existing AI-CG-Studio installation is present; refusing to overwrite it: ${JSON.stringify(before)}`)
  const result = await runCommand(installer, ['/S'], {
    cwd: path.dirname(installer), evidence, display: `${installer} /S`, timeoutMs: 10 * 60_000, windowsHide: false,
  })
  if (result.code !== 0) throw new Error(`NSIS /S install exited with ${result.code}`)
  const found = await waitFor('per-machine uninstall registry entry', () => findUninstallEntry()[0], 60_000, 500)
  const entry = found.value
  const installLocation = entry.installLocation || path.dirname(String(entry.uninstallString || '').replace(/^"|".*$/gu, ''))
  const executable = installedExecutable(installLocation)
  if (!executable) throw new Error(`installed executable not found in ${installLocation}`)
  const manifest = buildResourceManifest(installLocation)
  writeJson(path.join(evidence.directory, 'installed-resource-manifest.json'), manifest)
  evidence.artifact('installedResourceManifest', path.join(evidence.directory, 'installed-resource-manifest.json'))
  if (!manifest.ok) throw new Error(`installed resource manifest is incomplete: ${JSON.stringify(manifest.items.filter(item => !item.exists))}`)
  evidence.result('install', 'PASS', { exitCode: 0, installLocation, executable, registryEntry: entry.registryPath, previousEntries: before.length })
  return { entry, installLocation, executable }
}

function parseUninstallCommand(entry: any) {
  const raw = String(entry.quietUninstallString || entry.uninstallString || '').trim()
  const quoted = raw.match(/^"([^"]+)"\s*(.*)$/u)
  if (quoted) return { command: quoted[1], args: quoted[2] ? quoted[2].split(/\s+/u) : [] }
  const executable = raw.match(/^(.+?\.exe)(?:\s+(.*))?$/iu)
  if (!executable) throw new Error(`uninstall command is not parseable: ${raw}`)
  return { command: executable[1], args: executable[2] ? executable[2].split(/\s+/u) : [] }
}

async function uninstallProduct(evidence: any, installed: any) {
  const uninstall = parseUninstallCommand(installed.entry)
  const args = uninstall.args.filter(value => value.toUpperCase() !== '/S').concat('/S')
  const result = await runCommand(uninstall.command, args, {
    cwd: path.dirname(uninstall.command), evidence, display: `${uninstall.command} ${args.join(' ')}`,
    timeoutMs: 10 * 60_000, windowsHide: false,
  })
  if (result.code !== 0) throw new Error(`uninstaller /S exited with ${result.code}`)
  await waitFor('uninstall registry removal', () => findUninstallEntry().length === 0, 60_000, 500)
  if (fs.existsSync(installed.installLocation)) throw new Error(`install directory remains after uninstall: ${installed.installLocation}`)
  evidence.result('uninstall', 'PASS', { exitCode: 0, installLocationRemoved: true, registryRemoved: true })
}

async function startProductSession(context: any, tag: any, appArgs = []) {
  const existing = processesByExecutable(context.installed.executable)
  if (existing.length) throw new Error(`installed product is already running before ${tag}; refusing to kill an unowned process`)
  const userDataFolder = path.join(context.fixture.localAppData, 'WebView2', `${tag}-${Date.now()}`)
  const driver = new TauriDriver({
    executable: context.tools.tauriDriver,
    nativeDriver: context.tools.edgeDriver,
    environment: context.fixture.environment,
    evidence: context.evidence,
  })
  await driver.start()
  let session = null
  try {
    session = await driver.createSession({
      application: context.installed.executable,
      args: appArgs,
      userDataFolder,
      timeoutMs: 120_000,
    })
    const processResult = await waitFor('installed product process', () => processesByExecutable(context.installed.executable)[0], 30_000, 100)
    return { driver, session, pid: processResult.value.pid, userDataFolder, tag }
  } catch (error) {
    await session?.close()
    driver.close()
    throw error
  }
}

async function gatewayPort(fixture: any) {
  const filePath = path.join(fixture.configRoot, 'desktop-gateway.json')
  const result = await waitFor('desktop gateway port file', () => {
    try {
      const port = JSON.parse(fs.readFileSync(filePath, 'utf8')).port
      return Number.isInteger(port) ? port : false
    } catch { return false }
  }, 45_000, 200)
  return result.value
}

async function gatewayHealthy(port: any) {
  try {
    const response = await httpRequest(`http://127.0.0.1:${port}/api/status`, { timeoutMs: 3_000 })
    return response.status >= 200 && response.status < 500
  } catch {
    return false
  }
}

async function waitCompanionReady(product: any, expectVisible = true) {
  await product.session.waitFor('Companion /companion route', `
return location.pathname.replace(/\\/+$/, '') === '/companion' && Boolean(window.companionDesktop)
`, [], { timeoutMs: 60_000 })
  if (!expectVisible) return
  await product.session.waitFor('native Live2D ready on first load', `
const host = document.querySelector('.live2d-host[data-backend="native"]')
const stage = document.querySelector('.portrait-stage.live2d-ready')
return host && stage && host.dataset.state === 'ready'
`, [], { timeoutMs: 35_000, intervalMs: 100 })
}

async function live2dState(session: any) {
  return session.invoke('aics_live2d_get_state')
}

async function quitProduct(product: any, context: any, resultId = 'normal-exit') {
  const port = await gatewayPort(context.fixture).catch(() => null)
  const ownedBeforeQuit = processTree(product.pid)
  const ownedPids = new Set(ownedBeforeQuit.map((item: any) => item.pid))
  try {
    await product.session.executeAsync(`
if (!window.companionDesktop?.quit) throw new Error('Companion quit bridge unavailable')
return await window.companionDesktop.quit()
`, [], 10_000)
  } catch {}
  const exited = await waitFor('product and sidecar exit', () => {
    const running = processesByExecutable(context.installed.executable)
    const remainingOwned = processTree(product.pid).filter((item: any) => ownedPids.has(item.pid))
    const listeners = port ? portOwner(port) : []
    return running.length === 0 && remainingOwned.length === 0 && listeners.length === 0
  }, 10_000, 200).then(() => true).catch(() => false)
  await product.session.close()
  product.driver.close()
  if (!exited) {
    terminateOwnedPids([...ownedPids])
    throw new Error('normal quit did not terminate the product and owned gateway within 10 seconds')
  }
  context.evidence.result(resultId, 'PASS', { withinMs: 10_000, gatewayPort: port, ownedBeforeQuit })
}

function targetSnapshot(fixture: any) {
  return snapshotFiles(fixture.configRoot, [
    'companion-window.json',
    'companion-preferences.json',
    'desktop-gateway.json',
    'ai-workspace.json',
  ])
}

function compareSnapshots(expected: any, actual: any) {
  return Object.keys(expected).every(key => expected[key].sha256 === actual[key]?.sha256 && expected[key].bytes === actual[key]?.bytes)
}

async function exerciseHiddenStart(context: any) {
  const product = await startProductSession(context, 'hidden', ['--hidden'])
  try {
    await waitCompanionReady(product, false)
    const port = await gatewayPort(context.fixture)
    await waitFor('hidden gateway health', () => gatewayHealthy(port), 30_000, 250)
    const before = await live2dState(product.session)
    const windows = windowsForProcess(product.pid)
    const companion = windows.find((item: any) => item.title.includes('Companion'))
    const overlay = windows.find((item: any) => item.title === 'aics-live2d-overlay')
    if (before.active !== false) throw new Error(`hidden diagnostic query created overlay: ${JSON.stringify(before)}`)
    if (companion?.visible) throw new Error('Companion HWND is visible during --hidden startup')
    if (overlay?.visible) throw new Error('Live2D overlay HWND is visible during --hidden startup')
    context.evidence.result('hidden-start', 'PASS', {
      gatewayPort: port,
      gatewayHealthy: true,
      companionVisible: Boolean(companion?.visible),
      overlayVisible: Boolean(overlay?.visible),
      state: before,
    })
  } finally {
    await quitProduct(product, context, 'hidden-exit')
  }
}

async function installEventProbe(session: any) {
  await session.executeAsync(`
window.__d10Events = []
window.__d10MediaEvents = []
const names = ['aics:live2d:motion-started', 'aics:live2d:motion-failed', 'aics:live2d:hit-test', 'aics:live2d:entrance-finished']
for (const name of names) {
  await window.__TAURI__.event.listen(name, event => window.__d10Events.push({ name, payload: event.payload, at: performance.now() }))
}
if (!window.__d10MediaInstrumented) {
  window.__d10MediaInstrumented = true
  const play = HTMLMediaElement.prototype.play
  const pause = HTMLMediaElement.prototype.pause
  HTMLMediaElement.prototype.play = function () {
    window.__d10MediaEvents.push({ type: 'play', src: this.currentSrc || this.src, at: performance.now() })
    this.addEventListener('playing', () => window.__d10MediaEvents.push({ type: 'playing', src: this.currentSrc || this.src, at: performance.now() }), { once: true })
    this.addEventListener('ended', () => window.__d10MediaEvents.push({ type: 'ended', src: this.currentSrc || this.src, at: performance.now() }), { once: true })
    this.addEventListener('error', () => window.__d10MediaEvents.push({ type: 'error', src: this.currentSrc || this.src, at: performance.now() }), { once: true })
    return play.call(this)
  }
  HTMLMediaElement.prototype.pause = function () {
    window.__d10MediaEvents.push({ type: 'pause', src: this.currentSrc || this.src, at: performance.now() })
    return pause.call(this)
  }
}
return true
`, [], 15_000)
}

async function domSnapshot(session: any) {
  return session.execute(`
const stage = document.querySelector('.portrait-stage')
const host = document.querySelector('.live2d-host')
const page = document.querySelector('.companion-page')
const rect = stage?.getBoundingClientRect()
return {
  pathname: location.pathname,
  origin: location.origin,
  dpr: window.devicePixelRatio,
  innerWidth: window.innerWidth,
  innerHeight: window.innerHeight,
  character: page?.getAttribute('data-character'),
  backend: host?.getAttribute('data-backend'),
  hostState: host?.getAttribute('data-state'),
  stageReady: Boolean(stage?.classList.contains('live2d-ready')),
  stageRect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
  mouth: Number(stage?.getAttribute('data-mouth-level') || 0),
  audioPeak: Number(stage?.getAttribute('data-audio-peak') || 0),
  emotion: stage?.getAttribute('data-emotion'),
  speaking: Boolean(stage?.classList.contains('speaking')),
  powerMode: page?.getAttribute('data-power-mode'),
  mediaEvents: (window.__d10MediaEvents || []).slice(),
  events: (window.__d10Events || []).slice(),
}
`)
}

function rectEdges(rect: any) {
  return { left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height }
}

function rectError(a: any, b: any) {
  const ae = rectEdges(a)
  const be = rectEdges(b)
  const edges = {
    left: Math.abs(ae.left - be.left),
    top: Math.abs(ae.top - be.top),
    right: Math.abs(ae.right - be.right),
    bottom: Math.abs(ae.bottom - be.bottom),
  }
  return { edges, max: Math.max(...Object.values(edges)) }
}

async function rectMeasurement(product: any, includeHwnd = true) {
  const dom = await domSnapshot(product.session)
  const desktopState = await product.session.executeAsync('return await window.companionDesktop.getState()', [], 10_000)
  const native = await live2dState(product.session)
  const overlay = includeHwnd ? findWindow(product.pid, (item: any) => item.title === 'aics-live2d-overlay') : null
  if (!dom.stageRect || !desktopState.bounds || (includeHwnd && !overlay)) {
    throw new Error('rect measurement is missing DOM, desktop bounds, or overlay HWND')
  }
  const expected = {
    x: Math.round(desktopState.bounds.x + dom.stageRect.x * dom.dpr),
    y: Math.round(desktopState.bounds.y + dom.stageRect.y * dom.dpr),
    width: Math.round(dom.stageRect.width * dom.dpr),
    height: Math.round(dom.stageRect.height * dom.dpr),
  }
  const hwnd = overlay ? { x: overlay.x, y: overlay.y, width: overlay.width, height: overlay.height } : null
  return {
    capturedAt: now(), dom, desktopBounds: desktopState.bounds, expected, diagnostic: native.rect, hwnd,
    expectedToDiagnostic: rectError(expected, native.rect),
    diagnosticToHwnd: hwnd ? rectError(native.rect, hwnd) : null,
    windowDpi: overlay?.dpi ?? null,
    effectiveScale: desktopState.bounds.width / dom.innerWidth,
  }
}

async function waitRectAligned(product: any, timeoutMs = 200, operationAt = Date.now()) {
  let measurement = null
  while (Date.now() - operationAt <= timeoutMs) {
    measurement = await rectMeasurement(product, false)
    if (measurement.expectedToDiagnostic.max <= 2) {
      const alignedInMs = Date.now() - operationAt
      const withHwnd = await rectMeasurement(product, true)
      if (withHwnd.diagnosticToHwnd.max <= 2) return { ...withHwnd, alignedInMs }
      measurement = withHwnd
    }
    await delay(10)
  }
  throw new Error(`overlay rect did not align within ${timeoutMs}ms: ${JSON.stringify(measurement)}`)
}

async function exerciseRectAndLifecycle(context: any, product: any, dpiLabel: any) {
  const initial = await waitRectAligned(product, 500)
  const screenshotDir = path.join(context.evidence.directory, 'screenshots', dpiLabel)
  await product.session.screenshot(path.join(screenshotDir, 'webview-initial.png'))
  const companion = findWindow(product.pid, (item: any) => item.title.includes('Companion'))
  if (!companion) throw new Error('Companion HWND not found')
  captureDesktop({ x: companion.x, y: companion.y, width: companion.width, height: companion.height }, path.join(screenshotDir, 'desktop-initial.png'))
  context.evidence.result('overlay-rect', 'PASS', initial)
  context.evidence.setMatrix('dpi', dpiLabel, 'PASS')

  const original = { x: companion.x, y: companion.y, width: companion.width, height: companion.height }
  const display = context.environment.displays.find((item: any) => item.primary) || context.environment.displays[0]
  const moved = {
    x: Math.max(display.workX, Math.min(display.workX + display.workWidth - original.width, original.x + 120)),
    y: Math.max(display.workY, Math.min(display.workY + display.workHeight - original.height, original.y + 80)),
    width: Math.max(420, Math.min(display.workWidth, original.width + 80)),
    height: Math.max(620, Math.min(display.workHeight, original.height - 40)),
  }
  const movedAt = setWindowRect(companion.hwnd, moved)
  const afterMove = await waitRectAligned(product, 200, movedAt)
  const restoredAt = setWindowRect(companion.hwnd, original)
  const restored = await waitRectAligned(product, 200, restoredAt)
  context.evidence.result('move-resize', 'PASS', { moved, afterMove, restored })

  const beforeHide = await live2dState(product.session)
  await product.session.click('button[title^="隐藏 Companion"]')
  await waitFor('overlay hidden state', async () => (await live2dState(product.session)).visible === false, 500, 25)
  const hiddenA = await live2dState(product.session)
  await delay(2_000)
  const hiddenB = await live2dState(product.session)
  if (hiddenB.frameCount !== hiddenA.frameCount) {
    throw new Error(`frame count advanced while hidden: ${hiddenA.frameCount} -> ${hiddenB.frameCount}`)
  }
  const shownAt = sendToggleVisibilityHotkey()
  const shown = await waitRectAligned(product, 200, shownAt)
  context.evidence.result('hide-frame-stop', 'PASS', {
    beforeHide: beforeHide.frameCount,
    hiddenFrameCount: hiddenA.frameCount,
    afterTwoSeconds: hiddenB.frameCount,
    shown,
  })
  return original
}

async function exerciseMultiDisplay(context: any, product: any, originalRect: any) {
  const displays = context.environment.displays
  if (displays.length < 2) return
  const primary = displays.find((display: any) => display.primary) || displays[0]
  const secondaries = displays.filter((display: any) => display.device !== primary.device)
  const moves = []
  let sameDpiCovered = false
  let mixedDpiCovered = false
  for (const display of secondaries) {
    const width = Math.min(originalRect.width, display.workWidth)
    const height = Math.min(originalRect.height, display.workHeight)
    const target = {
      x: display.workX + Math.max(0, Math.floor((display.workWidth - width) / 2)),
      y: display.workY + Math.max(0, Math.floor((display.workHeight - height) / 2)),
      width,
      height,
    }
    const currentCompanion = findWindow(product.pid, (item: any) => item.title.includes('Companion'))
    if (!currentCompanion) throw new Error(`Companion HWND not found before moving to ${display.device}`)
    const movedAt = setWindowRect(currentCompanion.hwnd, target)
    const measurement = await waitRectAligned(product, 200, movedAt)
    const safeDevice = display.device.replace(/[^a-z0-9]+/giu, '-')
    await product.session.screenshot(path.join(context.evidence.directory, 'screenshots', 'dual-screen', `${safeDevice}-webview.png`))
    const companion = findWindow(product.pid, (item: any) => item.title.includes('Companion'))
    if (!companion) throw new Error(`Companion HWND disappeared after moving to ${display.device}`)
    captureDesktop(companion, path.join(context.evidence.directory, 'screenshots', 'dual-screen', `${safeDevice}-desktop.png`))
    const sameDpi = display.scalePercent === primary.scalePercent
    sameDpiCovered ||= sameDpi
    mixedDpiCovered ||= !sameDpi
    moves.push({ display, target, measurement, sameDpi })
  }
  const companion = findWindow(product.pid, (item: any) => item.title.includes('Companion'))
  if (!companion) throw new Error('Companion HWND disappeared before restoring the primary display')
  const restoredAt = setWindowRect(companion.hwnd, originalRect)
  const restored = await waitRectAligned(product, 200, restoredAt)
  setMatrixResult(context.evidence, 'displays', 'crossDisplay', 'PASS')
  setMatrixResult(context.evidence, 'displays', 'dualSameDpi', sameDpiCovered ? 'PASS' : 'BLOCKED')
  setMatrixResult(context.evidence, 'displays', 'dualMixedDpi', mixedDpiCovered ? 'PASS' : 'BLOCKED')
  context.evidence.result('dual-display', sameDpiCovered && mixedDpiCovered ? 'PASS' : 'BLOCKED', {
    reason: sameDpiCovered && mixedDpiCovered
      ? undefined
      : 'The attached real display set did not contain both same-DPI and mixed-DPI pairs.',
    primary,
    moves,
    restored,
  })
}

async function switchCharacter(product: any, character: any) {
  await product.session.click(`.character-tab[data-character="${character}"]`)
  await product.session.waitFor(`${character} ready`, `
const page = document.querySelector('.companion-page')
const stage = document.querySelector('.portrait-stage.live2d-ready')
return page?.getAttribute('data-character') === arguments[0] && stage?.getAttribute('data-character') === arguments[0]
`, [character], { timeoutMs: 35_000, intervalMs: 100 })
  const state = await live2dState(product.session)
  const dom = await domSnapshot(product.session)
  if (state.character !== character || dom.character !== character) {
    throw new Error(`character mismatch: requested=${character} state=${state.character} dom=${dom.character}`)
  }
  return { state, dom }
}

function findModelManifest(installLocation: any, character: any) {
  const directory = path.join(installLocation, 'gateway', 'assets', 'live2d', character)
  const names = fs.readdirSync(directory).filter(name => /model3?\.json$/iu.test(name) || name === 'model.json')
  const filePath = names.includes('model3.json') ? path.join(directory, 'model3.json') : path.join(directory, names[0])
  const manifest = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  const motions = manifest.FileReferences?.Motions || manifest.fileReferences?.motions || {}
  const durations = Object.fromEntries(Object.entries(motions).map(([group, items]) => [group, (Array.isArray(items) ? items : []).map(item => {
    const relative = item.File || item.file
    if (!relative) return 5
    try {
      const motion = JSON.parse(fs.readFileSync(path.join(directory, relative), 'utf8'))
      const duration = Number(motion.Meta?.Duration ?? motion.meta?.duration)
      return Number.isFinite(duration) && duration > 0 ? duration : 5
    } catch {
      return 5
    }
  })]))
  return {
    filePath,
    groups: Object.fromEntries(Object.entries(motions).map(([group, items]) => [group, Array.isArray(items) ? items.length : 0])),
    durations,
  }
}

async function exerciseCharactersAndMotion(context: any, product: any) {
  const natsume = await switchCharacter(product, 'natsume')
  const nene = await switchCharacter(product, 'nene')
  context.evidence.result('characters', 'PASS', { natsume: natsume.state, nene: nene.state })
  await installEventProbe(product.session)
  const manifest = findModelManifest(context.installed.installLocation, 'nene')
  const state = await live2dState(product.session)
  const bounds = state.modelBounds || state.rect
  const points = [
    { label: 'Face', x: 0.5, y: 0.24 },
    { label: 'Head', x: 0.5, y: 0.16 },
    { label: 'Body', x: 0.5, y: 0.68 },
    { label: 'Skirt', x: 0.5, y: 0.5 },
  ]
  const interactions = []
  for (const point of points) {
    const before = (await domSnapshot(product.session)).events.length
    sendClick(bounds.x + bounds.width * point.x, bounds.y + bounds.height * point.y)
    const event = await waitFor(`${point.label} hit/motion event`, async () => {
      const events = (await domSnapshot(product.session)).events.slice(before)
      return events.find((item: any) => item.name === 'aics:live2d:motion-started'
        || (item.name === 'aics:live2d:hit-test' && Array.isArray(item.payload) && item.payload.length > 0)) || false
    }, 5_000, 100)
    interactions.push({ point, event: event.value })
    await delay(600)
  }
  const multiGroups = Object.entries(manifest.groups).filter(([group, count]) => /^Tap/u.test(group) && count > 1)
  const observedIndexes = new Set()
  if (multiGroups.length) {
    const pointByGroup = { TapFace: points[0], TapHead: points[1], TapBody: points[2], TapSkirt: points[3] }
    const [targetGroup] = multiGroups.find(([group]) => pointByGroup[group]) || []
    if (!targetGroup) throw new Error(`no physical stage point is defined for authored multi-variant groups: ${multiGroups.map(([group]) => group).join(', ')}`)
    const repeatPoint = pointByGroup[targetGroup]
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const before = (await domSnapshot(product.session)).events.length
      sendClick(bounds.x + bounds.width * repeatPoint.x, bounds.y + bounds.height * repeatPoint.y)
      const started = await waitFor('multi-variant authored motion', async () => {
        const events = (await domSnapshot(product.session)).events.slice(before)
        return events.find((item: any) => item.name === 'aics:live2d:motion-started' && item.payload?.group === targetGroup) || false
      }, 6_000, 100)
      const index = Number(started.value.payload.index)
      observedIndexes.add(index)
      const duration = manifest.durations[targetGroup]?.[index] || 5
      await delay(Math.ceil(duration * 1000) + 750)
    }
    if (observedIndexes.size < 2) throw new Error(`multi-variant motion remained fixed: ${[...observedIndexes].join(', ')}`)
  }
  writeJson(path.join(context.evidence.directory, 'motion-manifest.json'), manifest)
  context.evidence.result('click-motion', 'PASS', {
    interactions,
    manifest,
    multiVariantObserved: [...observedIndexes],
    waivedBecauseSingleVariant: multiGroups.length === 0,
  })
}

function chatState(baseUrl: any, active: any, autoVoice: any) {
  return {
    version: 3,
    active,
    histories: { nene: [], natsume: [] },
    settings: {
      model: 'd10-deterministic', provider: 'api', apiBaseUrl: baseUrl, apiModel: 'd10-deterministic', apiKey: '',
      webSearchEnabled: false, live2dEnabled: true, live2dOutfit: active === 'natsume' ? 'natsume-cafe' : 'school',
      live2dOutfits: { nene: 'school', natsume: 'natsume-cafe' }, autoVoice, volume: 80, drafts: { nene: '', natsume: '' },
    },
  }
}

async function configureChat(product: any, mock: any, active: any, autoVoice: any) {
  await product.session.execute(`
localStorage.setItem('aics_chat_v1', JSON.stringify(arguments[0]))
localStorage.setItem('aics_companion_live2d_v1', 'true')
localStorage.setItem('aics_chat_thinking_v1', 'off')
location.reload()
return true
`, [chatState(mock.baseUrl, active, autoVoice)])
  await waitCompanionReady(product, true)
  await installEventProbe(product.session)
}

async function sendChat(product: any, text: any) {
  await product.session.fill('textarea[aria-label="桌宠聊天输入"]', text)
  await product.session.click('button.companion-send')
}

async function exerciseNoVoiceEmotion(context: any, product: any, mock: any) {
  await configureChat(product, mock, 'nene', false)
  await sendChat(product, 'd10-no-voice-happy')
  const happy = await product.session.waitFor('mock mood tag drives happy emotion', `
const stage = document.querySelector('.portrait-stage')
return stage?.getAttribute('data-emotion') === 'happy'
`, [], { timeoutMs: 10_000, intervalMs: 50 })
  const neutral = await product.session.waitFor('stream emotion resets to neutral', `
const stage = document.querySelector('.portrait-stage')
const send = document.querySelector('button.companion-send')
return stage?.getAttribute('data-emotion') === 'neutral' && send && !send.disabled
`, [], { timeoutMs: 15_000, intervalMs: 50 })
  context.evidence.result('emotion-no-voice', 'PASS', { happyInMs: happy.elapsedMs, neutralInMs: neutral.elapsedMs, mockRequests: mock.requests.length })
}

async function exerciseFps(context: any, product: any) {
  await product.session.executeAsync(`
await window.__TAURI__.event.emit('aics:power-mode', true)
return true
`, [], 10_000)
  await waitFor('native target FPS 30', async () => (await live2dState(product.session)).targetFps === 30, 2_000, 50)
  const efficiency = await live2dState(product.session)
  await product.session.executeAsync(`
await window.__TAURI__.event.emit('aics:power-mode', false)
return true
`, [], 10_000)
  await waitFor('native target FPS 165', async () => (await live2dState(product.session)).targetFps === 165, 2_000, 50)
  const quality = await live2dState(product.session)
  context.evidence.result('fps-30-165', 'PASS', { efficiency, quality })
}

async function downloadPlayedAudio(snapshot: any, evidence: any, fileName: any) {
  const play = [...snapshot.mediaEvents].reverse().find(event => event.type === 'playing' || event.type === 'play')
  if (!play?.src) throw new Error('no played audio URL was captured from the real chat voice path')
  const url = new URL(play.src, snapshot.origin).toString()
  const response = await httpRequest(url, { timeoutMs: 4 * 60_000 })
  if (response.status < 200 || response.status >= 300) throw new Error(`played audio download returned ${response.status}`)
  const filePath = path.join(evidence.directory, 'audio', fileName)
  fs.writeFileSync(filePath, response.body)
  return { filePath, url, metrics: wavQuality.analyzeWav(response.body), issues: wavQuality.assertVoiceQuality(wavQuality.analyzeWav(response.body)) }
}

async function exerciseTtsClip(context: any, product: any, character: any, emotion: any, dpiLabel: any) {
  await switchCharacter(product, character)
  const beforeMediaCount = (await domSnapshot(product.session)).mediaEvents.length
  await sendChat(product, `d10-tts-${emotion}-${character}`)
  const started = Date.now()
  const samples = []
  let openShot = false
  while (Date.now() - started < 4 * 60_000) {
    const dom = await domSnapshot(product.session)
    const native = await live2dState(product.session)
    samples.push({ atMs: Date.now() - started, mouth: dom.mouth, peak: dom.audioPeak, speaking: dom.speaking, emotion: dom.emotion, nativeMouth: native.mouthLevel, mapped: native.mouthMappedValue })
    if (!openShot && dom.speaking && dom.mouth > 0.04) {
      const companion = findWindow(product.pid, (item: any) => item.title.includes('Companion'))
      if (companion) {
        captureDesktop(companion, path.join(context.evidence.directory, 'screenshots', dpiLabel, `${character}-${emotion}-mouth-open.png`))
        openShot = true
      }
    }
    if (samples.some(sample => sample.speaking) && !dom.speaking && dom.mediaEvents.length > beforeMediaCount) break
    await delay(50)
  }
  if (!samples.some(sample => sample.speaking)) throw new Error(`${character}/${emotion} never entered speaking state`)
  await delay(500)
  const closedDom = await domSnapshot(product.session)
  const closedNative = await live2dState(product.session)
  const companion = findWindow(product.pid, (item: any) => item.title.includes('Companion'))
  if (companion) captureDesktop(companion, path.join(context.evidence.directory, 'screenshots', dpiLabel, `${character}-${emotion}-mouth-closed.png`))
  const maxMouth = Math.max(...samples.map(sample => sample.mouth))
  const maxNative = Math.max(...samples.map(sample => sample.nativeMouth))
  const mappedValues = samples.map(sample => sample.mapped)
  const minMapped = Math.min(...mappedValues)
  if (maxMouth < 0.04 || maxNative < 0.04) throw new Error(`${character}/${emotion} mouth telemetry stayed flat`)
  if (closedDom.mouth !== 0 || closedNative.mouthLevel !== 0 || closedNative.mouthMappedValue !== 0) {
    throw new Error(`${character}/${emotion} mouth did not reset within 500ms`)
  }
  const activeSamples = samples.filter(sample => sample.nativeMouth > 0.01)
  const mappingErrors = activeSamples.map(sample => Math.abs(sample.mapped - (character === 'natsume' ? -0.5 * sample.nativeMouth : sample.nativeMouth)))
  const maxMappingError = Math.max(0, ...mappingErrors)
  if (character === 'natsume' && !(minMapped < 0)) throw new Error(`Natsume mapped mouth value was not negative: ${minMapped}`)
  if (maxMappingError > 0.02) throw new Error(`${character}/${emotion} mouth mapping drifted by ${maxMappingError}`)
  const snapshot = await domSnapshot(product.session)
  const clipEvents = snapshot.mediaEvents.slice(beforeMediaCount)
  const playingEvents = clipEvents.filter((event: any) => event.type === 'playing')
  const endedEvents = clipEvents.filter((event: any) => event.type === 'ended')
  const errorEvents = clipEvents.filter((event: any) => event.type === 'error')
  if (playingEvents.length !== 1 || endedEvents.length !== 1 || errorEvents.length) {
    throw new Error(`${character}/${emotion} audio lifecycle was not single-play: ${JSON.stringify(clipEvents)}`)
  }
  const audio = await downloadPlayedAudio(snapshot, context.evidence, `${character}-${emotion}.wav`)
  if (audio.issues.length) throw new Error(`${character}/${emotion} WAV quality failed: ${audio.issues.join('; ')}`)
  return { character, emotion, maxMouth, maxNative, minMapped, maxMappingError, closedDom, closedNative, audio, clipEvents, samples }
}

async function exerciseRealTts(context: any, product: any, mock: any, dpiLabel: any) {
  await configureChat(product, mock, 'nene', true)
  const status = await product.session.executeAsync(`
const response = await fetch('/api/tts-status', { cache: 'no-store' })
return { status: response.status, body: await response.json() }
`, [], 10_000)
  if (!status.body?.online || !status.body?.voices?.nene || !status.body?.voices?.natsume) {
    throw new Error(`real GPT-SoVITS or voice profiles are unavailable: ${JSON.stringify(status)}`)
  }
  const clips = []
  for (const character of ['nene', 'natsume']) {
    for (const emotion of ['neutral', 'happy']) {
      const clip = await exerciseTtsClip(context, product, character, emotion, dpiLabel)
      clips.push(clip)
      const key = `${character}${emotion[0].toUpperCase()}${emotion.slice(1)}`
      context.evidence.setMatrix('tts', key, 'PASS')
    }
  }
  writeJson(path.join(context.evidence.directory, 'tts-metrics.json'), clips)
  context.evidence.result('tts-real', 'PASS', { clips: clips.map(clip => ({ character: clip.character, emotion: clip.emotion, maxMouth: clip.maxMouth, minMapped: clip.minMapped, metrics: clip.audio.metrics })) })
}

function average(values: any) {
  return values.reduce((sum: any, value: any) => sum + value, 0) / Math.max(1, values.length)
}

function trend(samples: any, field: any) {
  const values = samples.filter((sample: any) => Number.isFinite(sample[field]))
  if (values.length < 4) return null
  const quarter = Math.max(1, Math.floor(values.length / 4))
  const first = average(values.slice(0, quarter).map((sample: any) => sample[field]))
  const last = average(values.slice(-quarter).map((sample: any) => sample[field]))
  const meanT = average(values.map((sample: any) => sample.t))
  const meanV = average(values.map((sample: any) => sample[field]))
  let numerator = 0
  let denominator = 0
  for (const sample of values) {
    numerator += (sample.t - meanT) * (sample[field] - meanV)
    denominator += (sample.t - meanT) ** 2
  }
  return { count: values.length, firstQuarterAvg: first, lastQuarterAvg: last, deltaBytes: last - first, slopeBytesPerMinute: denominator ? numerator / denominator * 60_000 : 0 }
}

function assertStableTrend(name: any, stats: any) {
  if (!stats) throw new Error(`${name} trend is unavailable`)
  const deltaLimit = name === 'Working Set' ? 64 : 128
  const slopeLimit = name === 'Working Set' ? 2 : 8
  const deltaMiB = stats.deltaBytes / 1024 / 1024
  const slopeMiB = stats.slopeBytesPerMinute / 1024 / 1024
  if (deltaMiB > deltaLimit && slopeMiB > slopeLimit) {
    throw new Error(`${name} sustained growth delta=${deltaMiB.toFixed(1)}MiB slope=${slopeMiB.toFixed(2)}MiB/min`)
  }
}

async function exerciseSoak(context: any, product: any, originalRect: any, seconds: any) {
  const started = Date.now()
  const samples = []
  let nextSwitch = 60_000
  let nextAction = 30_000
  let nextSample = 0
  let character = (await domSnapshot(product.session)).character || 'nene'
  while (Date.now() - started < seconds * 1000) {
    const elapsed = Date.now() - started
    if (elapsed >= nextSwitch) {
      character = character === 'nene' ? 'natsume' : 'nene'
      await switchCharacter(product, character)
      nextSwitch += 60_000
    }
    if (elapsed >= nextAction) {
      if ((Math.floor(nextAction / 30_000) % 2) === 1) {
        await product.session.click('button[title^="隐藏 Companion"]')
        await delay(800)
        const shownAt = sendToggleVisibilityHotkey()
        await waitRectAligned(product, 200, shownAt)
      } else {
        const companion = findWindow(product.pid, (item: any) => item.title.includes('Companion'))
        if (companion) {
          const movedAt = setWindowRect(companion.hwnd, { ...originalRect, x: originalRect.x + 40, y: originalRect.y + 30 })
          await waitRectAligned(product, 200, movedAt)
          const restoredAt = setWindowRect(companion.hwnd, originalRect)
          await waitRectAligned(product, 200, restoredAt)
        }
      }
      nextAction += 30_000
    }
    if (elapsed >= nextSample) {
      const processSample = sampleProcessTree(product.pid)
      const native = await live2dState(product.session)
      samples.push({ t: Date.now(), elapsedMs: elapsed, ...processSample, frameCount: native.frameCount, targetFps: native.targetFps, character: native.character })
      nextSample += 10_000
    }
    await delay(100)
  }
  const steady = samples.filter(sample => sample.elapsedMs >= 120_000).map(sample => ({
    ...sample,
    gpuTotalBytes: Number.isFinite(sample.gpuDedicatedBytes) && Number.isFinite(sample.gpuSharedBytes)
      ? sample.gpuDedicatedBytes + sample.gpuSharedBytes : null,
  }))
  if (steady.length < 8) throw new Error(`insufficient post-warmup product samples: ${steady.length}`)
  const report = {
    seconds,
    samples,
    steadyWorkingSet: trend(steady, 'workingSetBytes'),
    steadyPrivateBytes: trend(steady, 'privateBytes'),
    steadyGpuTotal: trend(steady, 'gpuTotalBytes'),
  }
  assertStableTrend('Working Set', report.steadyWorkingSet)
  assertStableTrend('private bytes', report.steadyPrivateBytes)
  assertStableTrend('GPU total', report.steadyGpuTotal)
  writeJson(path.join(context.evidence.directory, 'product-soak.json'), report)
  context.evidence.result('soak-300s', 'PASS', report)
}

function copyDesktopLog(evidence: any, fixture: any) {
  const source = path.join(fixture.configRoot, 'desktop.log')
  if (fs.existsSync(source)) {
    fs.copyFileSync(source, evidence.desktopLogPath)
    evidence.artifact('desktopLog', evidence.desktopLogPath)
    return true
  }
  evidence.ensureDesktopLog(`expected product log was not found at ${source}`)
  return false
}

function matrixComplete(evidence: any) {
  const dpi = evidence.report.matrix.dpi
  const tts = evidence.report.matrix.tts
  return REQUIRED_DPI.every(label => dpi[label] === 'PASS')
    && Object.values(tts).every(value => value === 'PASS')
    && evidence.report.matrix.displays.single === 'PASS'
    && evidence.report.matrix.displays.dualSameDpi === 'PASS'
    && evidence.report.matrix.displays.dualMixedDpi === 'PASS'
    && evidence.report.matrix.displays.crossDisplay === 'PASS'
}

async function runAcceptance(args: any) {
  const evidence = new Evidence({ root: ROOT, directory: args['evidence-dir'] })
  const acceptanceCommand = 'npm run test:desktop:native'
  const acceptanceStarted = Date.now()
  evidence.commandStart(acceptanceCommand)
  let fixture = null
  let mock = null
  let installed = null
  let activeProduct = null
  let context = null
  let shouldUninstall = false
  try {
    if (process.platform !== 'win32') throw new Error('D-10 native desktop acceptance requires Windows')
    const locatedInstaller = args.installer || process.env.D10_INSTALLER || locateInstaller(ROOT)
    if (!locatedInstaller) throw new Error('NSIS installer not found; run npm run package:tauri first')
    const installerPath = path.resolve(locatedInstaller)
    if (!fs.existsSync(installerPath) || !fs.statSync(installerPath).isFile()) {
      throw new Error(`NSIS installer is not a file: ${installerPath}`)
    }
    const installer = verifyBuildRecord(evidence, installerPath)
    recordWorkflowEvidence(evidence, args)

    const environment = collectEnvironment()
    const cargo = findExecutable('cargo', [process.env.CARGO])
    const rustc = findExecutable('rustc', [process.env.RUSTC])
    const tauriDriver = findExecutable('tauri-driver', driverCandidates('tauri-driver'))
    const edgeDriver = findExecutable('msedgedriver', driverCandidates('msedgedriver'))
    const edgeDriverText = commandVersion(edgeDriver)
    const tools = {
      node: process.version,
      npm: commandVersion(npmInvocation(['--version']).command, npmInvocation(['--version']).args),
      cargo: commandVersion(cargo),
      rustc: commandVersion(rustc),
      tauriDriver,
      tauriDriverVersion: commandVersion(tauriDriver) || cargoInstalledVersion(tauriDriver, 'tauri-driver'),
      edgeDriver,
      edgeDriverVersion: edgeDriverText,
    }
    const dpi = currentDpiLabel(args, environment)
    environment.tools = tools
    environment.currentDpiRun = dpi
    environment.installer = installer
    environment.evidenceDirectory = evidence.directory
    evidence.setEnvironment(environment)
    const dpiEnvironmentPath = path.join(evidence.directory, `environment-${dpi.label}.json`)
    writeJson(dpiEnvironmentPath, environment)
    evidence.artifact(`environment${dpi.label}`, dpiEnvironmentPath)
    evidence.result('environment', 'PASS', { windows: environment.windows, gpu: environment.gpu, displays: environment.displays, tools })

    const aiWorkspace = resolveAiWorkspace(ROOT)
    const voiceProfilesPath = path.join(aiWorkspace, 'Voice', 'config', 'profiles.json')
    const gatewayPortValue = await freePort()
    const translatePort = await freePort()
    fixture = createIsolatedFixture({
      primaryDisplay: dpi.primary,
      gatewayPort: gatewayPortValue,
      translatePort,
      voiceProfilesPath,
      ttsHost: process.env.D10_TTS_HOST || 'http://127.0.0.1:9880',
    })
    const safety = safetyFailureInjection(fixture.tempRoot)
    evidence.result('user-data-isolation', 'PASS', {
      tempRoot: fixture.tempRoot,
      appData: fixture.appData,
      localAppData: fixture.localAppData,
      aiWorkspace: fixture.workspace,
      webviewData: fixture.webviewData,
      ...safety,
    })

    const blockers = []
    const existingInstalls = findUninstallEntry()
    if (!environment.isAdministrator) blockers.push('Current process is not elevated; perMachine NSIS installation is forbidden by the D-10 stop condition.')
    if (!tauriDriver) blockers.push('tauri-driver is missing.')
    if (!edgeDriver) blockers.push('msedgedriver is missing.')
    const edgeVersion = versionNumber(environment.edgeVersion)
    const driverVersion = versionNumber(edgeDriverText)
    if (edgeVersion && driverVersion && edgeVersion !== driverVersion) {
      blockers.push(`Edge/EdgeDriver version mismatch: Edge ${edgeVersion}, driver ${driverVersion}.`)
    }
    if (!REQUIRED_DPI.includes(dpi.label)) blockers.push(`Current real Windows scaling ${dpi.label}% is outside the required 100/125/150 matrix.`)
    if (existingInstalls.length) blockers.push('An existing AI-CG-Studio installation is present; the acceptance harness refuses to overwrite or uninstall it.')
    if (environment.displays.length < 2) {
      setMatrixResult(evidence, 'displays', 'dualSameDpi', 'BLOCKED')
      setMatrixResult(evidence, 'displays', 'dualMixedDpi', 'BLOCKED')
      setMatrixResult(evidence, 'displays', 'crossDisplay', 'BLOCKED')
      evidence.markScreenshotUnavailable('dual-screen', 'No real second Windows display was present. Virtual CSS viewports are not accepted.')
    }
    let ttsOnline = false
    try {
      const response = await httpRequest(`${process.env.D10_TTS_HOST || 'http://127.0.0.1:9880'}/openapi.json`, { timeoutMs: 2_000 })
      ttsOnline = response.status >= 200 && response.status < 500
    } catch {}
    if (!ttsOnline) blockers.push('Real GPT-SoVITS is offline; fake WAV substitution is prohibited.')

    if (blockers.length) {
      const reason = blockers.join(' ')
      evidence.result('preflight', 'BLOCKED', { reason, blockers })
      markDownstreamBlocked(evidence, reason)
      setMatrixResult(evidence, 'dpi', dpi.label, 'BLOCKED')
      setMatrixResult(evidence, 'displays', 'single', 'BLOCKED')
      for (const key of Object.keys(evidence.report.matrix.tts)) setMatrixResult(evidence, 'tts', key, 'BLOCKED')
      for (const label of REQUIRED_DPI) {
        const screenshotReason = label === dpi.label
          ? `Real ${label}% scaling was present, but product screenshots were blocked by preflight: ${reason}`
          : `Real ${label}% Windows scaling was not active during this run.`
        evidence.markScreenshotUnavailable(label, screenshotReason)
      }
      evidence.ensureDesktopLog(reason)
      evidence.finalize('BLOCKED')
      process.exitCode = 2
      return
    }
    evidence.result('preflight', 'PASS', { administrator: true, edgeVersion, driverVersion, ttsOnline })

    installed = await installProduct(evidence, installerPath)
    shouldUninstall = true
    mock = await startMockOpenAi()
    context = { evidence, environment, fixture, installed, tools, mock }

    activeProduct = await startProductSession(context, 'cold')
    await waitCompanionReady(activeProduct, true)
    const coldState = await live2dState(activeProduct.session)
    const coldDom = await domSnapshot(activeProduct.session)
    if (coldDom.backend !== 'native' || !coldState.ready) throw new Error(`cold start did not produce native ready state: ${JSON.stringify({ coldDom, coldState })}`)
    evidence.result('cold-start', 'PASS', { pid: activeProduct.pid, state: coldState, dom: coldDom })
    const sourceAfterCold = verifySourceSnapshot(fixture)
    const migration = verifyMigration(fixture)
    writeJson(path.join(evidence.directory, 'migration.json'), { sourceAfterCold, migration })
    if (!sourceAfterCold.ok) throw new Error(`product modified the read-only Electron migration source: ${JSON.stringify(sourceAfterCold.mismatches)}`)
    if (!migration.ok) throw new Error(`migration bytes/token/marker failed: ${JSON.stringify(migration)}`)
    evidence.result('migration', 'PASS', migration)
    const targetBeforeIdempotence = targetSnapshot(fixture)
    await quitProduct(activeProduct, context)
    activeProduct = null

    const mutatedSnapshot = mutateSourceFixture(fixture, 'companion-window.json', { x: 777, y: 333, width: 500, height: 700 })
    await exerciseHiddenStart(context)
    const sourceAfterHidden = verifySourceSnapshot(fixture, mutatedSnapshot)
    const targetAfterHidden = targetSnapshot(fixture)
    if (!sourceAfterHidden.ok) throw new Error('product changed the controlled second-launch migration source')
    if (!compareSnapshots(targetBeforeIdempotence, targetAfterHidden)) throw new Error('second launch overwrote migrated target data')
    evidence.result('migration-idempotence', 'PASS', { targetBeforeIdempotence, targetAfterHidden })

    activeProduct = await startProductSession(context, `dpi-${dpi.label}`)
    await waitCompanionReady(activeProduct, true)
    await installEventProbe(activeProduct.session)
    const originalRect = await exerciseRectAndLifecycle(context, activeProduct, dpi.label)
    setMatrixResult(evidence, 'displays', 'single', 'PASS')
    await exerciseMultiDisplay(context, activeProduct, originalRect)
    await exerciseCharactersAndMotion(context, activeProduct)
    await exerciseNoVoiceEmotion(context, activeProduct, mock)
    await exerciseFps(context, activeProduct)
    await exerciseRealTts(context, activeProduct, mock, dpi.label)
    await exerciseSoak(context, activeProduct, originalRect, Number(args['soak-seconds'] || 300))
    await quitProduct(activeProduct, context)
    activeProduct = null
    copyDesktopLog(evidence, fixture)
    await uninstallProduct(evidence, installed)
    shouldUninstall = false
    installed = null

    if (environment.displays.length < 2) {
      evidence.result('dual-display', 'BLOCKED', { reason: 'No real second Windows display was present.' })
    }
    for (const label of REQUIRED_DPI) {
      if (evidence.report.matrix.dpi[label] !== 'PASS') {
        evidence.markScreenshotUnavailable(label, `Real ${label}% Windows scaling was not active during this run.`)
      }
    }
    if (!matrixComplete(evidence)) {
      evidence.result('matrix-completeness', 'BLOCKED', { reason: 'The real 100/125/150 and dual-display matrix is incomplete; no viewport simulation was used.' })
    }
    const overall = evidence.finalize()
    process.exitCode = overall === 'PASS' ? 0 : 2
  } catch (error) {
    evidence.result('acceptance-run', 'FAIL', { message: runtimeErrorStack(error) || runtimeErrorMessage(error) })
    evidence.finalize('FAIL')
    process.exitCode = 1
  } finally {
    if (activeProduct && context) {
      try { await quitProduct(activeProduct, context, 'cleanup-exit') } catch (error) {
        evidence.failure('cleanup-exit', 'FAIL', runtimeErrorMessage(error))
      }
    }
    if (fixture) copyDesktopLog(evidence, fixture)
    if (shouldUninstall && installed) {
      try { await uninstallProduct(evidence, installed) } catch (error) {
        evidence.failure('cleanup-uninstall', 'FAIL', runtimeErrorMessage(error))
      }
    }
    if (mock) await mock.close().catch(() => {})
    if (fixture) {
      try { removeFixture(fixture) } catch (error) {
        evidence.failure('temp-cleanup', 'FAIL', runtimeErrorMessage(error))
      }
    }
    evidence.write()
    evidence.commandEnd(acceptanceCommand, Number(process.exitCode || 0), Date.now() - acceptanceStarted)
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args['record-command']) await recordCommand(args)
  else await runAcceptance(args)
}

main().catch(error => {
  console.error(error.stack || error)
  process.exitCode = 1
})
