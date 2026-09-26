import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, type Browser, type Page } from '@playwright/test'
import { Shell, alive, bootstrap, gone, invoke, port, prepareWorkspace, until, workspace } from './electron-shell/fixture.mjs'
import { directoryBytes, measure, windows } from './electron-shell/measure.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const { values } = parseArgs({ options: {
  electron: { type: 'string' }, node: { type: 'string' }, 'gateway-root': { type: 'string' },
  'ui-root': { type: 'string' }, 'native-exe': { type: 'string' }, out: { type: 'string' },
  'assets-root': { type: 'string' }, 'sample-ms': { type: 'string', default: '2000' },
  'resume-native': { type: 'string' },
  'resume-costs': { type: 'string' },
  'skip-native': { type: 'boolean', default: false }, 'skip-metrics': { type: 'boolean', default: false }, help: { type: 'boolean' },
} })
if (values.help) {
  console.log('Isolated Electron acceptance: --electron <verified electron.exe> --node <pinned node.exe> --gateway-root <built gateway> --ui-root <same frontend dist> --native-exe <R12 candidate> --out <new evidence directory> [--assets-root <existing assets>] [--sample-ms 2000] [--skip-native] [--skip-metrics] [--resume-native <prior report> | --resume-costs <prior report>]')
  process.exit(0)
}
assert.equal(process.platform, 'win32')
for (const key of ['electron', 'node', 'gateway-root', 'ui-root', 'native-exe', 'out'] as const) assert.ok(values[key], `Missing --${key}`)
const resolved = (value: string) => fs.realpathSync(path.resolve(value))
const electron = resolved(values.electron!), node = resolved(values.node!)
const gateway = resolved(values['gateway-root']!), ui = resolved(values['ui-root']!), native = resolved(values['native-exe']!)
const assets = resolved(values['assets-root'] || path.join(gateway, 'assets'))
const out = path.resolve(values.out!), sampleMs = Number(values['sample-ms'])
assert.ok(Number.isInteger(sampleMs) && sampleMs >= 1000 && sampleMs <= 10_000)
assert.ok(!fs.existsSync(out), '--out must be new; previous evidence is retained')
fs.mkdirSync(out, { recursive: true })
const hash = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const report: Record<string, any> = { schemaVersion: 1, startedAt: new Date().toISOString(), status: 'running',
  inputs: { electron: { path: electron, sha256: hash(electron) }, node: { path: node, sha256: hash(node) },
    native: { path: native, sha256: hash(native) }, ui: { root: ui, indexSha256: hash(path.join(ui, 'index.html')) }, gateway, assets },
  productionProfileAccessed: false, installationChanged: false, aiGenerationInvoked: false, checks: [], metrics: {},
  nativeSkipped: values['skip-native'], visualReview: 'Inspect generated native-window and UI PNGs before calling appearance passed',
  metricsSkipped: values['skip-metrics'], runtimeStartDelayMs: 15_000, providers: 'Explicit unavailable loopback http://127.0.0.1:9',
}
const save = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n')
const check = (name: string, detail: Record<string, unknown> = {}) => { report.checks.push({ name, passed: true, ...detail }); save(); console.log(`PASS ${name}`) }
assert.ok(!(values['resume-native'] && values['resume-costs']), 'Choose a single resume phase')
const costsOnly = Boolean(values['resume-costs'])
const previousFile = values['resume-costs'] || values['resume-native']
const previousPath = previousFile ? resolved(previousFile) : undefined
const previous = previousPath ? JSON.parse(fs.readFileSync(previousPath, 'utf8')) : undefined
if (previous) {
  const expected = costsOnly ? { ...previous.inputs, ui: { ...previous.inputs.ui, indexSha256: report.inputs.ui.indexSha256 } } : previous.inputs
  assert.deepEqual(expected, report.inputs, 'Resume requires the same bound executables and resource roots; native continuation also requires the same UI')
  assert.ok(previous.checks.some((item: any) => item.name === 'renderer-crash-isolated-and-reopened' && item.passed))
  report.reusedEvidence = { path: previousPath, sha256: hash(previousPath!), scope: 'Completed pre-native checks and idle/startup metrics; native client correction does not execute in idle workload' }
  report.checks = previous.checks.map((item: any) => ({ ...item, reused: true, evidence: previousPath, sourceUiSha256: item.sourceUiSha256 || previous.inputs.ui.indexSha256 }))
  report.metrics = { ...previous.metrics }
  report.package = previous.package
  if (costsOnly) {
    assert.ok(previous.native?.length === 2, 'Cost completion reuses two already-rendered models')
    report.native = previous.native
    report.reusedEvidence.scope = 'Completed functional checks, startup timing, and actual model pictures; cost samples are excluded and replaced'
    report.reusedEvidence.sourceUiSha256 = previous.inputs.ui.indexSha256
    report.verificationScope = 'Current UI: two cost workloads and normal exit. Shell reopen, functional checks, and earlier model pictures retain the UI hashes of their referenced evidence.'
    report.metrics = {}
    report.invalidPreviousMetrics = { path: previousPath, scopes: ['idleThreeWindows', 'nativeVisible'],
      reason: 'Excluded in favor of fresh matched-workload samples requiring creation-time ancestry, three visible windows, equal UI/DPR, and both decoded homepage images. Prior samples remain in their source reports.' }
  }
}
save()
// The real SQLite boundary forbids private workspaces inside the application.
const fixture = previous?.fixture.pocRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'huiyu-electron-poc-'))
assert.ok(path.basename(fixture).startsWith('huiyu-electron-poc-') && path.dirname(fixture) === os.tmpdir(), 'Use only the explicit isolated fixture')
fs.writeFileSync(path.join(fixture, '.huiyu-electron-poc'), 'Explicit isolated acceptance fixture\n')
const config = { pocRoot: fixture, userData: path.join(fixture, 'profile'), configRoot: path.join(fixture, 'config'),
  aiRoot: path.join(fixture, 'ai'), webRoot: ui, gatewayRoot: gateway, nodeExe: node, nativeExe: native, assetsRoot: assets,
  gatewayPort: await port(), debugPort: await port(), probe: true, show: true, runtimeStartDelayMs: previous ? 0 : 15_000 }
report.runtimeStartDelayMs = config.runtimeStartDelayMs
let prepared: ReturnType<typeof prepareWorkspace>
try { prepared = previous?.fixture || prepareWorkspace(node, gateway, config.configRoot, config.userData) }
catch (error) { report.status = 'failed'; report.error = String(error); report.finishedAt = new Date().toISOString(); save(); throw error }
const preferences = path.join(config.configRoot, 'electron-shell.json')
fs.writeFileSync(preferences, JSON.stringify({ ...(fs.existsSync(preferences) ? JSON.parse(fs.readFileSync(preferences, 'utf8')) : {}), live2dEnabled: false }))
report.fixture = { ...prepared, pocRoot: fixture }
const configPath = path.join(out, 'config.json')
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
let shell: Shell | undefined, browser: Browser | undefined
const owned = new Set<number>()
const rolePages = new Map<string, Page>()
async function connect() {
  if (!browser) {
    await until(async () => (await fetch(`http://127.0.0.1:${config.debugPort}/json/version`, { signal: AbortSignal.timeout(1000) })).ok,
      value => value, 'Electron CDP endpoint')
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${config.debugPort}`, { timeout: 10_000 })
  }
  // CDP can briefly retain the destroyed page after a window is reopened. Bind
  // only live documents whose real main-process bootstrap accepts their sender.
  const pages = await until(async () => {
    const candidates = browser!.contexts().flatMap(context => context.pages()).filter(page => !page.isClosed() && page.url().startsWith('https://huiyu.localhost'))
    const entries = await Promise.all(candidates.map(async page => {
      try {
        await page.waitForFunction(() => !!Reflect.get(window, '__HUIYU_ELECTRON__'), undefined, { timeout: 1000 })
        return [(await bootstrap(page)).windowRole, page] as const
      } catch { return null }
    }))
    return new Map<string, Page>(entries.filter(entry => entry !== null))
  }, value => value.size === 3, 'three live bundled window identities')
  rolePages.clear()
  for (const [role, page] of pages) rolePages.set(role, page)
  assert.deepEqual([...rolePages.keys()].sort(), ['atelier', 'companion', 'companion-chat'])
  assert.deepEqual(await rolePages.get('atelier')!.evaluate(() => ({ node: typeof Reflect.get(window, 'require'),
    process: typeof Reflect.get(window, 'process'), tauri: typeof Reflect.get(window, '__TAURI__'),
    arbitraryInvoke: typeof Reflect.get(window, '__HUIYU_ELECTRON__').invoke })),
    { node: 'undefined', process: 'undefined', tauri: 'undefined', arbitraryInvoke: 'undefined' })
}
async function ready(page: Page) {
  return until(() => bootstrap(page), value => value.connection === 'ready' && !!value.runtime?.workspace, 'private runtime bootstrap', 50_000)
}
async function readyHomepage(page: Page) {
  // The deliberate offline-first boot can retain HomeView's failed-image state.
  // Reload after runtime readiness so both shells measure the same actual art.
  await page.reload(); await ready(page)
  const pictures = await until(() => page.evaluate(() => [...document.querySelectorAll<HTMLImageElement>('.hero-character')].map(image => ({
    path: new URL(image.src).pathname, complete: image.complete, width: image.naturalWidth, height: image.naturalHeight,
  }))), value => value.length === 2 && value.every(image => image.complete && image.width > 0), 'both homepage hero images decoded')
  report.homepagePictures = pictures
}
async function capture(page: Page, name: string) { await page.screenshot({ path: path.join(out, `${name}.png`) }) }
async function captureSettledThemes(page: Page) {
  for (const theme of ['light', 'dark']) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const button = page.locator('.app-theme-toggle')
      const stateMatches = (await button.getAttribute('aria-pressed') === 'true') === (theme === 'light')
      if (stateMatches && await page.locator('html').getAttribute('data-theme') === theme) break
      await button.click(); await delay(500)
    }
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme)
    await delay(500)
    await capture(page, `atelier-${theme}`)
  }
}
async function darkWindows() {
  for (const page of rolePages.values()) {
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; localStorage.setItem('aics_theme', 'dark') })
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark')
  }
  await delay(500)
}
async function displays() {
  return Promise.all([...rolePages].map(async ([role, page]) => ({ role, ...await page.evaluate(() => ({
    dpr: devicePixelRatio, screen: { width: screen.width, height: screen.height, availableWidth: screen.availWidth, availableHeight: screen.availHeight },
    viewport: { width: innerWidth, height: innerHeight }, theme: document.documentElement.dataset.theme,
  })) })))
}
function displayIdentity(snapshot: Awaited<ReturnType<typeof displays>>) {
  return JSON.stringify(snapshot.map(({ role, dpr, screen }) => ({ role, dpr, screen })).sort((a, b) => a.role.localeCompare(b.role)))
}
async function measureDisplayWorkload() {
  const before = await displays()
  const result = await measure(shell!.process.pid!, sampleMs)
  const after = await displays()
  const stable = displayIdentity(before) === displayIdentity(after) && displayIdentity(before) === displayIdentity(report.displayAtStart)
  if (!stable) report.displayChanged = true
  return { ...result, display: { before, after, stable }, comparison: stable ? 'Compare only to an equivalent recorded DPR/screen/UI workload' : 'Display changed; not eligible for strict cross-shell ranking' }
}
async function comparisonWindows() {
  await rolePages.get('atelier')!.locator('h1').first().waitFor()
  await invoke(rolePages.get('atelier')!, 'open_atelier', { pathname: '/' })
  await invoke(rolePages.get('atelier')!, 'open_companion_chat')
  await darkWindows()
  const status = await until(() => shell!.request('status'), value => value.windows.length === 3 && value.windows.every((window: any) => window.visible), 'three visible native comparison windows')
  assert.equal(status.windows.length, 3)
  assert.ok(status.windows.every((window: any) => window.visible), 'All three native windows must be visible during comparison')
  return status.windows
}
async function shutdown() {
  if (!shell) return
  const tree = windows.processTree(shell.process.pid!) as { pid: number }[]
  for (const process of tree) owned.add(process.pid)
  await shell.request('exit')
  await shell.closed
  for (const pid of owned) await gone(pid)
  browser = undefined; shell = undefined; rolePages.clear()
}
try {
  const started = performance.now()
  shell = new Shell(electron, path.join(root, 'desktop-electron/main.cjs'), configPath, out)
  owned.add(shell.process.pid!)
  await connect()
  const atelier = rolePages.get('atelier')!
  report.displayAtStart = await displays()
  if (!previous) {
  await atelier.waitForFunction(() => (document.querySelector('#app')?.textContent?.trim().length || 0) > 30)
  report.metrics.uiReadyMs = performance.now() - started
  const startupCompanion = rolePages.get('companion')!
  await startupCompanion.locator('.companion-page').waitFor()
  await startupCompanion.bringToFront()
  await startupCompanion.keyboard.press('Shift+F10')
  await startupCompanion.locator('.companion-page[data-controls-open="true"]').waitFor()
  report.metrics.uiInteractiveMs = performance.now() - started
  await startupCompanion.keyboard.press('Escape')
  const early = await bootstrap(atelier)
  assert.notEqual(early.connection, 'ready', 'Bundled UI must be usable before delayed runtime starts')
  check('bundled-ui-before-runtime', { elapsedMs: report.metrics.uiReadyMs, connection: early.connection })
  await capture(atelier, 'atelier-starting')
  const initial = await ready(atelier)
  report.metrics.runtimeReadyMs = performance.now() - started
  assert.equal(initial.runtime.workspace.workspaceId, prepared.workspaceId)
  const descriptors = await Promise.all([...rolePages.values()].map(ready))
  assert.ok(descriptors.every(item => item.runtime.workspace.workspaceId === prepared.workspaceId))
  check('three-window-identities-and-private-workspace', { roles: descriptors.map(item => item.windowRole), workspaceId: prepared.workspaceId })
  await assert.rejects(invoke(rolePages.get('companion')!, 'desktop_workspace_prepare'), /FORBIDDEN/)
  check('sandboxed-fixed-capabilities-and-main-role-authorization')
  await readyHomepage(atelier)
  const idleWindows = await comparisonWindows()
  if (!values['skip-metrics']) report.metrics.idleThreeWindows = { ...await measureDisplayWorkload(), windows: idleWindows }
  const written = await workspace(atelier, '/projects', { kind: 'saveProject', operationId: crypto.randomUUID(),
    project: { id: 'electron-proof', name: 'Electron comparison fixture' }, artworkIds: [], expectedRevision: null })
  assert.equal(written.status, 200, JSON.stringify(written.body))
  const projects = await workspace(atelier, '/projects')
  assert.ok(projects.body.result.items.some((item: any) => item.id === 'electron-proof'))
  check('private-sqlite-write-read')
  await atelier.reload(); await ready(atelier)
  const reloaded = await workspace(atelier, '/projects')
  assert.ok(reloaded.body.result.items.some((item: any) => item.id === 'electron-proof'))
  check('window-reload-preserves-private-record')
  await captureSettledThemes(atelier)
  await darkWindows()
  report.package = { electronRuntimeBytes: directoryBytes(path.dirname(electron)), uiBytes: directoryBytes(ui),
    nativeExecutableBytes: fs.statSync(native).size, nodeExecutableBytes: fs.statSync(node).size,
    scope: 'uncompressed selected runtime components; shared gateway/assets excluded, no installer claim' }
  const url = atelier.url(), handle = await atelier.evaluate(() => { const marker = crypto.randomUUID(); Reflect.set(window, '__r13Document', marker); return marker })
  await shell.request('stop-runtime')
  await until(() => bootstrap(atelier), value => value.connection !== 'ready', 'runtime disconnect')
  assert.equal(atelier.url(), url)
  assert.equal(await atelier.evaluate(() => Reflect.get(window, '__r13Document')), handle)
  assert.ok(await atelier.locator('#app').isVisible())
  check('runtime-stop-keeps-ui-document')
  await shell.request('start-runtime')
  const resumed = await ready(atelier)
  assert.notEqual(resumed.runtime.runtimeEpoch, initial.runtime.runtimeEpoch)
  assert.equal(resumed.runtime.workspace.workspaceId, prepared.workspaceId)
  assert.equal(await atelier.evaluate(() => Reflect.get(window, '__r13Document')), handle)
  const rejected = await workspace(atelier, '/status', undefined, initial.runtime.workspace.token)
  assert.equal(rejected.status, 401)
  check('runtime-restart-new-epoch-rejects-old-session')
  await shell.request('crash-window', { role: 'companion-chat' })
  assert.equal((await ready(atelier)).runtime.workspace.workspaceId, prepared.workspaceId)
  await shell.request('reopen-window', { role: 'companion-chat' })
  await connect()
  check('renderer-crash-isolated-and-reopened')
  } else {
    assert.equal((await ready(atelier)).runtime.workspace.workspaceId, prepared.workspaceId)
    assert.ok((await workspace(atelier, '/projects')).body.result.items.some((item: any) => item.id === 'electron-proof'))
    await darkWindows()
    check('prior-private-library-reopened-for-native-completion')
    if (costsOnly && !values['skip-metrics']) {
      const companion = rolePages.get('companion')!
      await companion.locator('.companion-page').waitFor()
      await companion.bringToFront(); await companion.keyboard.press('Shift+F10')
      await companion.locator('.companion-page[data-controls-open="true"]').waitFor()
      report.metrics.uiInteractiveMs = performance.now() - started
      report.startupMeasurement = 'Existing isolated profile reopened on current UI; real Shift+F10 interaction, no artificial runtime delay; not a fresh-profile startup ranking'
      await companion.keyboard.press('Escape')
      await readyHomepage(atelier)
      await captureSettledThemes(atelier)
      assert.equal((await invoke(rolePages.get('companion')!, 'aics_live2d_get_state')).ready, false)
      const idleWindows = await comparisonWindows()
      report.metrics.idleThreeWindows = { ...await measureDisplayWorkload(), windows: idleWindows }
      check('three-visible-window-idle-costs-with-creation-time-tree')
    }
  }
  if (!values['skip-native']) {
    const companion = rolePages.get('companion')!
    await companion.locator('.companion-page').waitFor()
    if (!costsOnly) report.native = []
    for (const character of costsOnly ? ['natsume'] : ['nene', 'natsume']) {
      // Exercise the real Vue consumer: UI selection/enable must compile the
      // adapter and place the overlay. Direct IPC loading would miss that seam.
      await companion.bringToFront()
      if (await companion.locator('.companion-page').getAttribute('data-controls-open') !== 'true') {
        await companion.keyboard.press('Shift+F10')
        await companion.locator('.companion-page[data-controls-open="true"]').waitFor()
      }
      const picker = companion.getByRole('combobox', { name: '切换陪伴角色' })
      if (await picker.getAttribute('data-value') !== character) {
        await picker.click()
        await companion.locator(`.companion-picker-option[data-value="${character}"]`).click()
      }
      const avatar = companion.locator('.avatar-status')
      await until(() => avatar.isEnabled(), Boolean, 'avatar enable/retry action available')
      const avatarState = await avatar.getAttribute('data-state')
      if (!['loading', 'checking', 'ready'].includes(avatarState || '')) await avatar.click()
      await companion.locator(`.portrait-stage.live2d-ready[data-character="${character}"]`).waitFor({ timeout: 60_000 })
      assert.equal(await companion.locator('.live2d-host').getAttribute('data-backend'), 'native')
      const state = await until(() => invoke(companion, 'aics_live2d_get_state'),
        value => value.ready && value.visible && value.character === character && value.frameCount > 0, `${character} native frames`, 60_000)
      await companion.keyboard.press('Escape')
      await delay(500)
      if (costsOnly) {
        const status = await shell.request('status')
        const window = status.windows.find((window: any) => window.role === 'companion')
        const file = path.join(out, 'natsume-desktop-composite.png')
        windows.captureDesktop(window.bounds, file)
        report.desktopComposite = { path: file, sha256: hash(file), source: 'Windows CopyFromScreen of the real companion region, including desktop/WebView/native composition' }
        continue
      }
      const nativeStatus = await shell.request('status')
      const snapshot = await shell.request('native-snapshot', { label: `${character}-gpu` })
      assert.ok(fs.existsSync(snapshot.path), 'Native GPU snapshot must exist')
      await capture(companion, `${character}-companion-webview`)
      report.native.push({ character, state, process: nativeStatus.native, snapshot: { path: snapshot.path, sha256: hash(snapshot.path) } })
      assert.ok(Number.isSafeInteger(nativeStatus.native?.childPid), 'Native diagnostic must identify the owned renderer')
      owned.add(nativeStatus.native.childPid); owned.add(nativeStatus.native.hostPid)
      const overlay = (windows.windowsForProcess(nativeStatus.native.childPid) as any[]).find(window => window.Title === 'aics-live2d-overlay')
      assert.ok(overlay?.Visible, 'The native model window must actually be visible')
      windows.captureWindow(overlay.Hwnd, path.join(out, `${character}-native-window.png`))
      const companionWindow = nativeStatus.windows.find((window: any) => window.role === 'companion')
      windows.captureDesktop(companionWindow.bounds, path.join(out, `${character}-desktop-composite.png`))
      check(`${character}-native-model-renders`)
    }
    if (!values['skip-metrics']) {
      const nativeWindows = await comparisonWindows()
      await invoke(companion, 'aics_live2d_set_max_fps', { fps: 60 })
      const before = await until(() => invoke(companion, 'aics_live2d_get_state'), value => value.targetFps === 60, 'native comparison 60 FPS target')
      const sampleStarted = performance.now()
      report.metrics.nativeVisible = await measureDisplayWorkload()
      const after = await invoke(companion, 'aics_live2d_get_state')
      assert.equal(after.targetFps, 60)
      assert.ok(after.frameCount > before.frameCount, 'The native model must keep producing actual frames')
      Object.assign(report.metrics.nativeVisible, { character: after.character, targetFps: after.targetFps,
        windows: nativeWindows, frameDelta: after.frameCount - before.frameCount, frameWindowMs: performance.now() - sampleStarted,
        rect: after.rect, architecture: 'Electron main + separate R12 probe supervisor + native renderer child; not a pure framework comparison' })
      check('three-visible-window-native-costs-at-confirmed-60-fps-target')
    }
    // Quit with the model alive: this exercises native ownership cleanup rather
    // than relying on a UI control that is intentionally hidden in ready state.
  }
  await shutdown()
  check('electron-runtime-native-exit-without-orphans')
  if (!costsOnly) {
  config.runtimeStartDelayMs = 0
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
  shell = new Shell(electron, path.join(root, 'desktop-electron/main.cjs'), configPath, out)
  owned.clear(); owned.add(shell.process.pid!)
  await connect()
  const reopenedAtelier = rolePages.get('atelier')!
  const reopened = await ready(reopenedAtelier)
  assert.equal(reopened.runtime.workspace.workspaceId, prepared.workspaceId)
  assert.ok((await workspace(reopenedAtelier, '/projects')).body.result.items.some((item: any) => item.id === 'electron-proof'))
  check('full-shell-reopen-preserves-sqlite-library')
  await shutdown()
  }
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'; report.error = error instanceof Error ? error.stack : String(error)
  report.failureWindows = []
  for (const [role, page] of rolePages) {
    try {
      await capture(page, `${role}-failure`)
      report.failureWindows.push({ role, url: page.url(), ui: await page.evaluate(() => ({
        avatarState: document.querySelector('.avatar-status')?.getAttribute('data-state'),
        avatarText: document.querySelector('.avatar-status')?.textContent,
        backend: document.querySelector('.live2d-host')?.getAttribute('data-backend'),
        character: document.querySelector('.companion-page')?.getAttribute('data-character'),
      })) })
    } catch { /* A crashed renderer has no readable document. */ }
  }
  throw error
} finally {
  if (shell && alive(shell.process.pid!)) {
    try { await shell.request('exit', {}, 10_000); await shell.closed } catch {
      // ChildProcess retains the actual process handle. Never terminate a raw
      // ancestry-derived PID list: Windows can reuse an unrelated parent's PID.
      shell.process.kill()
      await Promise.race([shell.closed, delay(10_000, undefined, { ref: false })])
    }
  }
  await browser?.close().catch(() => {})
  report.finishedAt = new Date().toISOString(); save()
}
