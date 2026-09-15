'use strict'

const assert: typeof import('node:assert/strict') = require('node:assert/strict')
const fs: typeof import('node:fs') = require('node:fs')
const os: typeof import('node:os') = require('node:os')
const path: typeof import('node:path') = require('node:path')
const { test }: typeof import('node:test') = require('node:test')
const { Evidence }: typeof import('./desktop-native/report') = require('./desktop-native/report')

function installer(sha: any, fingerprint: any) {
  return {
    path: `C:\\fixture\\${sha}.exe`,
    sha256: sha,
    sizeBytes: 1,
    modifiedAt: new Date(0).toISOString(),
    version: '1.5.0',
    packagingFingerprint: { sha256: fingerprint, fileCount: 1, totalBytes: 1 },
  }
}

test('a new installer cycle cannot inherit prior PASS evidence or artifacts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-d10-evidence-'))
  const directory = path.join(root, 'evidence')
  try {
    const evidence = new Evidence({ root, directory })
    const first = installer('a'.repeat(64), 'b'.repeat(64))
    assert.equal(evidence.beginInstallerCycle(first, { head: '1'.repeat(40) }), true)
    evidence.result('install', 'PASS')
    evidence.setMatrix('dpi', '100', 'PASS')
    evidence.setWorkflow({
      status: 'PASS',
      url: 'https://github.com/example/repo/actions/runs/1',
      runId: '1',
      commitSha: '1'.repeat(40),
      conclusion: 'success',
      reason: null,
    })
    fs.writeFileSync(path.join(directory, 'screenshots', '100', 'old.png'), 'old')
    fs.writeFileSync(path.join(directory, 'audio', 'old.wav'), 'old')
    fs.writeFileSync(path.join(directory, 'migration.json'), '{}')

    assert.equal(evidence.beginInstallerCycle(first, { head: '1'.repeat(40) }), false)
    assert.equal(evidence.report.results.find((item: any) => item.id === 'install')?.status, 'PASS')

    const second = installer('c'.repeat(64), 'd'.repeat(64))
    assert.equal(evidence.beginInstallerCycle(second, { head: '2'.repeat(40) }), true)
    assert.equal(evidence.report.results.length, 0)
    assert.equal(evidence.report.failures.length, 0)
    assert.equal(evidence.report.matrix.dpi['100'], 'NOT_COVERED')
    assert.equal(evidence.report.workflow.status, 'NOT_RUN')
    assert.equal(evidence.report.installer.sha256, second.sha256)
    assert.equal(fs.existsSync(path.join(directory, 'screenshots', '100', 'old.png')), false)
    assert.equal(fs.existsSync(path.join(directory, 'audio', 'old.wav')), false)
    assert.equal(fs.existsSync(path.join(directory, 'migration.json')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
