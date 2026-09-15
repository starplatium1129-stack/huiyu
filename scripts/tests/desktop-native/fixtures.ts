'use strict'

const crypto: typeof import('node:crypto') = require('node:crypto')
const fs: typeof import('node:fs') = require('node:fs')
const os: typeof import('node:os') = require('node:os')
const path: typeof import('node:path') = require('node:path')

const MIGRATED_JSON = [
  'companion-window.json',
  'companion-preferences.json',
  'desktop-gateway.json',
  'ai-workspace.json',
]

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex')
}

function canonicalForComparison(value) {
  return path.resolve(value).replace(/[\\/]+$/u, '').toLowerCase()
}

function assertInside(root, candidate, label) {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(candidate)
  const relative = path.relative(resolvedRoot, resolved)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escaped the D-10 temporary root: ${resolved}`)
  }
  return resolved
}

function assertNotRealUserPath(candidate, label) {
  const appData = process.env.APPDATA
  const localAppData = process.env.LOCALAPPDATA
  const profileRoots = [appData, localAppData].filter(Boolean).map(canonicalForComparison)
  const productRoots = ['ai-cg-studio', 'AI-CG-Studio', 'aics-studio', 'com.aics.studio']
    .flatMap(name => [appData && path.join(appData, name), localAppData && path.join(localAppData, name)])
    .filter(Boolean)
    .map(canonicalForComparison)
  const resolved = canonicalForComparison(candidate)
  if (profileRoots.includes(resolved) || productRoots.some(real => resolved === real || resolved.startsWith(`${real}${path.sep}`))) {
    throw new Error(`${label} resolved into the real user profile: ${candidate}`)
  }
}

function writeBytes(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, data)
}

function writeJson(filePath, value) {
  writeBytes(filePath, Buffer.from(JSON.stringify(value), 'utf8'))
}

function makeReadOnly(filePath) {
  fs.chmodSync(filePath, 0o444)
}

function makeWritable(filePath) {
  fs.chmodSync(filePath, 0o644)
}

function snapshotFiles(directory, relativeFiles) {
  return Object.fromEntries(relativeFiles.map(relative => {
    const filePath = path.join(directory, relative)
    const data = fs.readFileSync(filePath)
    return [relative.replace(/\\/g, '/'), { bytes: data.length, sha256: sha256(data) }]
  }))
}

function createIsolatedFixture(options) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-d10-round1-'))
  const appData = assertInside(tempRoot, path.join(tempRoot, 'AppData', 'Roaming'), 'APPDATA')
  const localAppData = assertInside(tempRoot, path.join(tempRoot, 'AppData', 'Local'), 'LOCALAPPDATA')
  const workspace = assertInside(tempRoot, path.join(tempRoot, 'AI'), 'AI workspace')
  const temporary = assertInside(tempRoot, path.join(tempRoot, 'Temp'), 'TEMP')
  const electronSource = assertInside(tempRoot, path.join(appData, 'ai-cg-studio'), 'Electron migration source')
  const configRoot = assertInside(tempRoot, path.join(appData, 'com.aics.studio'), 'Tauri config root')
  const webviewData = assertInside(tempRoot, path.join(localAppData, 'WebView2', crypto.randomUUID()), 'WebView2 user data')
  for (const [label, candidate] of Object.entries({ appData, localAppData, workspace, temporary, electronSource, configRoot, webviewData })) {
    assertNotRealUserPath(candidate, label)
    fs.mkdirSync(candidate, { recursive: true })
  }

  const primary = options.primaryDisplay || { workX: 0, workY: 0, workWidth: 1920, workHeight: 1080 }
  const width = Math.min(540, Math.max(360, primary.workWidth - 80))
  const height = Math.min(760, Math.max(480, primary.workHeight - 80))
  const fixtures = {
    'companion-window.json': { x: primary.workX + 24, y: primary.workY + 40, width, height },
    'companion-preferences.json': { alwaysOnTop: false, ignoreMouseEvents: false, live2dEnabled: true },
    'desktop-gateway.json': { port: options.gatewayPort },
    'ai-workspace.json': { root: workspace },
  }
  for (const [name, value] of Object.entries(fixtures)) {
    const filePath = path.join(electronSource, name)
    writeJson(filePath, value)
    makeReadOnly(filePath)
  }
  const tokenRelative = path.join('gateway', 'runtime', 'state', 'gateway_token')
  const tokenPath = path.join(electronSource, tokenRelative)
  writeBytes(tokenPath, Buffer.from('d10-round1-fixed-gateway-token', 'utf8'))
  makeReadOnly(tokenPath)
  const sourceRelativeFiles = [...MIGRATED_JSON, tokenRelative]
  const sourceSnapshot = snapshotFiles(electronSource, sourceRelativeFiles)

  const profiles = JSON.parse(fs.readFileSync(options.voiceProfilesPath, 'utf8'))
  const runtimeConfig = path.join(configRoot, 'gateway', 'config.json')
  writeJson(runtimeConfig, { voices: profiles, ttsHost: options.ttsHost || 'http://127.0.0.1:9880' })

  const environment = {
    ...process.env,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    TEMP: temporary,
    TMP: temporary,
    AI_WORKSPACE_ROOT: workspace,
    PORT: String(options.gatewayPort),
    TRANSLATE_PORT: String(options.translatePort),
    TTS_HOST: options.ttsHost || 'http://127.0.0.1:9880',
    AICS_DISABLE_LEGACY_RUNTIME_MIGRATION: '1',
  }

  return {
    tempRoot,
    appData,
    localAppData,
    workspace,
    temporary,
    electronSource,
    configRoot,
    webviewData,
    sourceRelativeFiles,
    sourceSnapshot,
    runtimeConfig,
    environment,
  }
}

function verifySourceSnapshot(fixture, expected = fixture.sourceSnapshot) {
  const actual = snapshotFiles(fixture.electronSource, fixture.sourceRelativeFiles)
  const mismatches = []
  for (const relative of fixture.sourceRelativeFiles.map(value => value.replace(/\\/g, '/'))) {
    if (actual[relative]?.sha256 !== expected[relative]?.sha256 || actual[relative]?.bytes !== expected[relative]?.bytes) {
      mismatches.push({ relative, expected: expected[relative], actual: actual[relative] })
    }
  }
  return { ok: mismatches.length === 0, actual, mismatches }
}

function verifyMigration(fixture) {
  const files = []
  for (const name of MIGRATED_JSON) {
    const source = path.join(fixture.electronSource, name)
    const target = path.join(fixture.configRoot, name)
    const sourceData = fs.readFileSync(source)
    const targetData = fs.existsSync(target) ? fs.readFileSync(target) : null
    files.push({
      name,
      sourceSha256: sha256(sourceData),
      targetSha256: targetData ? sha256(targetData) : null,
      byteEqual: Boolean(targetData && sourceData.equals(targetData)),
    })
  }
  const sourceToken = fs.readFileSync(path.join(fixture.electronSource, 'gateway', 'runtime', 'state', 'gateway_token'))
  const expectedTokenPath = path.join(fixture.configRoot, 'gateway', 'runtime', 'state', 'gateway_token')
  const expectedToken = fs.existsSync(expectedTokenPath) ? fs.readFileSync(expectedTokenPath) : null
  const markerPath = path.join(fixture.configRoot, '.tauri-migrated')
  const token = {
    expectedPath: expectedTokenPath,
    expectedByteEqual: Boolean(expectedToken && sourceToken.equals(expectedToken)),
  }
  return {
    files,
    token,
    markerPath,
    markerExists: fs.existsSync(markerPath),
    ok: files.every(file => file.byteEqual) && token.expectedByteEqual && fs.existsSync(markerPath),
  }
}

function mutateSourceFixture(fixture, name, value) {
  const filePath = assertInside(fixture.tempRoot, path.join(fixture.electronSource, name), 'controlled migration mutation')
  makeWritable(filePath)
  writeJson(filePath, value)
  makeReadOnly(filePath)
  return snapshotFiles(fixture.electronSource, fixture.sourceRelativeFiles)
}

function removeFixture(fixture) {
  assertInside(fixture.tempRoot, fixture.appData, 'cleanup APPDATA')
  assertInside(fixture.tempRoot, fixture.localAppData, 'cleanup LOCALAPPDATA')
  assertInside(fixture.tempRoot, fixture.workspace, 'cleanup AI workspace')
  assertNotRealUserPath(fixture.tempRoot, 'cleanup root')
  fs.rmSync(fixture.tempRoot, { recursive: true, force: true })
}

function safetyFailureInjection(tempRoot) {
  let rejected = false
  try {
    assertInside(tempRoot, process.env.APPDATA || os.homedir(), 'deliberate real-path probe')
  } catch {
    rejected = true
  }
  if (!rejected) throw new Error('path guard did not reject the deliberate real user-data path')
  return { rejectedRealUserDataPath: true }
}

export = {
  MIGRATED_JSON,
  assertInside,
  createIsolatedFixture,
  mutateSourceFixture,
  removeFixture,
  safetyFailureInjection,
  snapshotFiles,
  verifyMigration,
  verifySourceSnapshot,
}
