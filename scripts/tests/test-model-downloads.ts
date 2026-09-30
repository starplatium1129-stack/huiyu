import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { downloadModel, matchesModel, runModelDownloads } from '../lib/model-download'
import { H3_FILES, WD14_FILES, type ModelFile } from '../lib/model-download-manifest'
import { h3Url } from '../maintenance/download-minimax-h3'
import { inspectModelFile, checkModels } from '../maintenance/check-models-environment'

const bytes = Buffer.from('synthetic model fixture, no real weight or inference')
const entry: ModelFile = { path: 'model.bin', repo: 'fixture', revision: 'fixture', remotePath: 'model.bin',
  bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }

async function fixture(run: (root: string, url: string, requests: string[]) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huiyu-model-download-'))
  const requests: string[] = []
  const server = http.createServer((request, response) => {
    const route = request.url || '/'
    requests.push(route)
    if (route === '/redirect') { response.writeHead(302, { location: '/good' }); response.end(); return }
    if (route === '/loop') { response.writeHead(302, { location: '/loop' }); response.end(); return }
    if (route === '/stall') { response.writeHead(200, { 'content-length': bytes.length }); response.write(bytes.subarray(0, 1)); return }
    if (route === '/truncated') { response.writeHead(200, { 'content-length': bytes.length }); response.write(bytes.subarray(0, 2)); setImmediate(() => response.destroy()); return }
    const body = route === '/bad-hash' ? Buffer.alloc(bytes.length) : route === '/short' ? bytes.subarray(0, 3) : bytes
    response.writeHead(200, { 'content-length': body.length }); response.end(body)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as { port: number }
  try { await run(root, `http://127.0.0.1:${address.port}`, requests) } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    const resolved = fs.realpathSync(root)
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()))
    assert.ok(path.basename(resolved).startsWith('huiyu-model-download-'))
    fs.rmSync(resolved, { recursive: true, force: true })
  }
}

test('verified download publishes exact bytes; repeat uses SHA-256 without another request', async () => {
  await fixture(async (root, url, requests) => {
    const target = path.join(root, entry.path)
    assert.equal(await downloadModel(url + '/redirect', target, entry), 'downloaded')
    assert.deepEqual(fs.readFileSync(target), bytes)
    assert.equal(await matchesModel(target, entry), true)
    assert.equal(await downloadModel(url + '/good', target, entry), 'verified-existing')
    assert.deepEqual(requests, ['/redirect', '/good'])
    assert.deepEqual(fs.readdirSync(root), ['model.bin'])
  })
})

test('same-size corrupt or partial final weight is replaced only after a verified download', async () => {
  await fixture(async (root, url) => {
    const target = path.join(root, entry.path)
    fs.writeFileSync(target, Buffer.alloc(bytes.length))
    assert.equal(await matchesModel(target, entry), false)
    await downloadModel(url + '/good', target, entry)
    assert.deepEqual(fs.readFileSync(target), bytes)
    fs.writeFileSync(target, bytes.subarray(0, 2))
    await downloadModel(url + '/good', target, entry)
    assert.deepEqual(fs.readFileSync(target), bytes)
  })
})

for (const route of ['/bad-hash', '/short', '/truncated', '/loop']) {
  test(`failed ${route} response preserves prior file and removes partials`, async () => {
    await fixture(async (root, url) => {
      const target = path.join(root, entry.path)
      fs.writeFileSync(target, 'prior incomplete download')
      await assert.rejects(downloadModel(url + route, target, entry))
      assert.equal(fs.readFileSync(target, 'utf8'), 'prior incomplete download')
      assert.deepEqual(fs.readdirSync(root), ['model.bin'])
    })
  })
}

test('idle timeout and user cancellation release stalled transfers', async () => {
  await fixture(async (root, url) => {
    const target = path.join(root, entry.path)
    await assert.rejects(downloadModel(url + '/stall', target, entry, { timeoutMs: 20, totalTimeoutMs: 1000 }))
    const cancel = new AbortController()
    const transfer = downloadModel(url + '/stall', target, entry, { signal: cancel.signal, onProgress() { cancel.abort() } })
    await assert.rejects(transfer)
    assert.deepEqual(fs.readdirSync(root), [])
  })
})

test('download lock rejects reentry and successful completion removes the lock', async () => {
  await fixture(async (root, url) => {
    const lock = path.join(root, '.huiyu-model-download.lock')
    fs.writeFileSync(lock, '{}')
    await assert.rejects(runModelDownloads(root, [entry], () => url + '/good'), /lock exists/)
    fs.unlinkSync(lock)
    await runModelDownloads(root, [entry], () => url + '/good')
    assert.equal(fs.existsSync(lock), false)
  })
})

test('H3 download manifest covers both runtime sampling LoRAs and the exact six requirements', () => {
  const catalog = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../runtime-rs/src/video/catalog.json'), 'utf8')).constants
  const model = catalog.MODEL_CATALOG.find((model: { id: string }) => model.id === 'minimax-h3')
  assert.deepEqual([...H3_FILES.map(file => file.path)].sort(), model.requirements.map((parts: string[]) => parts.join('/')).sort())
  for (const file of [...H3_FILES, ...WD14_FILES]) {
    assert.match(file.sha256, /^[a-f0-9]{64}$/)
    assert.match(file.revision, /^[a-f0-9]{40}$/)
    assert.ok(file.bytes > 0)
  }
  for (const file of H3_FILES.filter(file => file.path.startsWith('loras/'))) {
    assert.match(h3Url(file, 'official'), new RegExp(`/resolve/${file.revision}/loras/`))
    assert.equal(file.repo, 'Comfy-Org/MiniMax-H3')
  }
})

test('model inspection distinguishes empty, partial and same-size corruption', async () => {
  await fixture(async root => {
    const target = path.join(root, entry.path)
    assert.equal((await inspectModelFile(root, entry.path, entry)).state, 'missing')
    fs.writeFileSync(target, '')
    assert.equal((await inspectModelFile(root, entry.path, entry)).state, 'missing')
    fs.writeFileSync(target, 'incomplete')
    assert.equal((await inspectModelFile(root, entry.path, entry)).state, 'size-mismatch')
    fs.writeFileSync(target, Buffer.alloc(bytes.length))
    assert.equal((await inspectModelFile(root, entry.path, entry, true)).state, 'hash-mismatch')
    fs.writeFileSync(target, bytes)
    assert.equal((await inspectModelFile(root, entry.path, entry, true)).state, 'sha256-match')
  })
})

test('offline inventory uses configured roots and does not combine models from different directories', async () => {
  await fixture(async root => {
    const app = path.join(root, 'app')
    const ai = path.join(root, 'custom-ai')
    const scan = path.join(root, 'scan-only')
    const translation = path.join(root, 'translation')
    const source = path.resolve(__dirname, '../..')
    for (const relative of ['runtime-rs/src/images/catalog.json', 'runtime-rs/src/video/catalog.json', 'runtime-rs/native-dependencies.windows-x64.json']) {
      fs.mkdirSync(path.dirname(path.join(app, relative)), { recursive: true })
      fs.copyFileSync(path.join(source, relative), path.join(app, relative))
    }
    fs.mkdirSync(translation, { recursive: true })
    fs.writeFileSync(path.join(translation, 'config.json'), '{}')
    const report = await checkModels(app, { AI_WORKSPACE_ROOT: ai, COMFYUI_MODELS_ROOT: scan, AICS_TRANSLATION_MODEL: translation,
      AICS_RUNTIME_ROOT: path.join(root, 'runtime'), OLLAMA_MODELS: path.join(root, 'ollama') }, false, false)
    assert.equal(report.roots.gatewayPathMatchesScan, false)
    assert.equal(report.roots.runtimeComfyRoot, path.join(ai, 'ComfyUI/models'))
    assert.equal(report.translation.directory, translation)
    assert.equal(report.inference, 'not-run')
    assert.ok(report.imageModels.length >= 7)
    assert.equal(report.videoModels.find(model => model.id === 'wan2.2-14b')?.adapter, 'unavailable')
    assert.ok(report.imageModels.every(model => model.files.every(file => file.state === 'missing')))
  })
})
