'use strict'

const fs: typeof import('node:fs') = require('node:fs')
const path: typeof import('node:path') = require('node:path')

const EVIDENCE_RELATIVE = path.join('Reviews', 'DesktopAcceptance', '2026-08-09_d10_round1')
const SCREENSHOT_LABELS = ['100', '125', '150', 'dual-screen']

function emptyWorkflow() {
  return {
    status: 'NOT_RUN',
    url: null,
    runId: null,
    commitSha: null,
    conclusion: null,
    reason: 'No self-hosted workflow URL/run id/commit SHA was supplied.',
  }
}

function emptyMatrix() {
  return {
    dpi: { 100: 'NOT_COVERED', 125: 'NOT_COVERED', 150: 'NOT_COVERED' },
    displays: { single: 'NOT_COVERED', dualSameDpi: 'NOT_COVERED', dualMixedDpi: 'NOT_COVERED', crossDisplay: 'NOT_COVERED' },
    tts: { neneNeutral: 'NOT_COVERED', neneHappy: 'NOT_COVERED', natsumeNeutral: 'NOT_COVERED', natsumeHappy: 'NOT_COVERED' },
  }
}

function now() {
  return new Date().toISOString()
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true })
}

function atomicWrite(filePath, text) {
  ensureDirectory(path.dirname(filePath))
  const temporary = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(temporary, text, 'utf8')
  fs.renameSync(temporary, filePath)
}

function writeJson(filePath, value) {
  atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return fallback
  }
}

function resolveAiWorkspace(root, configured) {
  const workspace = path.resolve(
    configured
      || process.env.D10_AI_WORKSPACE
      || process.env.AI_WORKSPACE_ROOT
      || path.join(root, '..', 'AI'),
  )
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
    throw new Error(`AI workspace does not exist: ${workspace}`)
  }
  return workspace
}

function resolveEvidenceDirectory(root, configured) {
  if (configured || process.env.D10_EVIDENCE_DIR) {
    return path.resolve(configured || process.env.D10_EVIDENCE_DIR)
  }
  return path.join(resolveAiWorkspace(root), EVIDENCE_RELATIVE)
}

class Evidence {
  constructor(options) {
    this.root = options.root
    this.directory = resolveEvidenceDirectory(options.root, options.directory)
    this.reportPath = path.join(this.directory, 'report.json')
    this.environmentPath = path.join(this.directory, 'environment.json')
    this.failuresPath = path.join(this.directory, 'failures.json')
    this.commandsPath = path.join(this.directory, 'commands.log')
    this.desktopLogPath = path.join(this.directory, 'desktop.log')
    this.report = readJson(this.reportPath, {
      schemaVersion: 2,
      task: 'D-10 desktop native release acceptance',
      round: '2026-08-09_d10_round1',
      createdAt: now(),
      updatedAt: now(),
      overall: 'IN_PROGRESS',
      installer: null,
      freeze: null,
      workflow: emptyWorkflow(),
      matrix: emptyMatrix(),
      results: [],
      failures: [],
      artifacts: {},
    })
    ensureDirectory(this.directory)
    for (const label of SCREENSHOT_LABELS) {
      ensureDirectory(path.join(this.directory, 'screenshots', label))
    }
    ensureDirectory(path.join(this.directory, 'audio'))
    this.report.artifacts ||= {}
    this.report.artifacts.commandsLog = this.commandsPath
    this.report.artifacts.failures = this.failuresPath
    this.write()
  }

  appendCommand(text) {
    ensureDirectory(this.directory)
    fs.appendFileSync(this.commandsPath, text.endsWith('\n') ? text : `${text}\n`, 'utf8')
  }

  commandStart(command) {
    this.appendCommand(`\n[${now()}] $ ${command}`)
  }

  commandOutput(stream, text) {
    const normalized = String(text || '').replace(/\r\n/g, '\n')
    if (!normalized) return
    this.appendCommand(normalized.split('\n').filter(Boolean).map(line => `[${stream}] ${line}`).join('\n'))
  }

  commandEnd(command, code, durationMs, error) {
    this.appendCommand(`[${now()}] exit=${code} durationMs=${durationMs} command=${command}${error ? ` error=${error}` : ''}`)
  }

  setEnvironment(value) {
    writeJson(this.environmentPath, value)
    this.report.artifacts.environment = this.environmentPath
    this.write()
  }

  setInstaller(value) {
    this.report.installer = value
    this.write()
  }

  setFreeze(value) {
    this.report.freeze = value
    this.write()
  }

  beginInstallerCycle(installer, freeze) {
    const previous = this.report.installer
    const unchanged = previous?.sha256 === installer.sha256
      && previous?.packagingFingerprint?.sha256 === installer.packagingFingerprint?.sha256
    if (unchanged) {
      this.setInstaller(installer)
      this.setFreeze(freeze)
      return false
    }

    for (const label of SCREENSHOT_LABELS) {
      const directory = path.join(this.directory, 'screenshots', label)
      fs.rmSync(directory, { recursive: true, force: true })
      ensureDirectory(directory)
    }
    const audioDirectory = path.join(this.directory, 'audio')
    fs.rmSync(audioDirectory, { recursive: true, force: true })
    ensureDirectory(audioDirectory)
    const staleFiles = new Set([
      'desktop.log',
      'environment.json',
      'installed-resource-manifest.json',
      'migration.json',
      'motion-manifest.json',
      'product-soak.json',
      'tts-metrics.json',
    ])
    for (const name of fs.readdirSync(this.directory)) {
      if (staleFiles.has(name) || /^environment-\d+\.json$/u.test(name)) {
        fs.rmSync(path.join(this.directory, name), { force: true })
      }
    }

    this.report.schemaVersion = 2
    this.report.overall = 'IN_PROGRESS'
    this.report.installer = installer
    this.report.freeze = freeze
    this.report.workflow = emptyWorkflow()
    this.report.matrix = emptyMatrix()
    this.report.results = []
    this.report.failures = []
    this.report.artifacts = {
      commandsLog: this.commandsPath,
      failures: this.failuresPath,
    }
    writeJson(this.failuresPath, [])
    this.write()
    return true
  }

  setWorkflow(value) {
    this.report.workflow = value
    this.write()
  }

  setMatrix(section, key, value) {
    if (!this.report.matrix[section]) this.report.matrix[section] = {}
    this.report.matrix[section][key] = value
    this.write()
  }

  result(id, status, details = {}) {
    const item = { id, status, at: now(), ...details }
    const index = this.report.results.findIndex(entry => entry.id === id)
    if (index >= 0) this.report.results[index] = item
    else this.report.results.push(item)
    if (status === 'FAIL' || status === 'BLOCKED') {
      this.failure(id, status, details.message || details.reason || 'No detail supplied', details)
    } else {
      const before = this.report.failures.length
      this.report.failures = this.report.failures.filter(entry => entry.id !== id)
      if (this.report.failures.length !== before) writeJson(this.failuresPath, this.report.failures)
    }
    this.write()
    return item
  }

  failure(id, kind, message, details = {}) {
    const item = { id, kind, message, at: now(), details }
    const index = this.report.failures.findIndex(entry => entry.id === id && entry.kind === kind)
    if (index >= 0) this.report.failures[index] = item
    else this.report.failures.push(item)
    writeJson(this.failuresPath, this.report.failures)
    this.write()
  }

  artifact(name, filePath) {
    this.report.artifacts[name] = filePath
    this.write()
  }

  ensureDesktopLog(reason) {
    if (!fs.existsSync(this.desktopLogPath)) {
      atomicWrite(this.desktopLogPath, `[D-10 harness] Product desktop.log unavailable: ${reason}\n`)
    }
    this.artifact('desktopLog', this.desktopLogPath)
  }

  markScreenshotUnavailable(label, reason) {
    const directory = path.join(this.directory, 'screenshots', label)
    ensureDirectory(directory)
    atomicWrite(path.join(directory, 'NOT_COVERED.txt'), `${reason}\n`)
  }

  finalize(forcedStatus) {
    const statuses = this.report.results.map(item => item.status)
    this.report.overall = forcedStatus
      || (statuses.includes('FAIL') ? 'FAIL' : statuses.includes('BLOCKED') ? 'BLOCKED' : 'PASS')
    this.report.updatedAt = now()
    this.write()
    return this.report.overall
  }

  write() {
    this.report.updatedAt = now()
    writeJson(this.reportPath, this.report)
  }
}

export = {
  EVIDENCE_RELATIVE,
  Evidence,
  atomicWrite,
  now,
  readJson,
  resolveAiWorkspace,
  resolveEvidenceDirectory,
  writeJson,
}
