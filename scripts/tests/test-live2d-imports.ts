import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import express from 'express'
import { importCandidates } from '../maintenance/import-live2d-candidates'
import { localLive2dRoot, readLocalCompanions } from '../../services/live2d-local'
import { modelFile, modelFormat } from '../../services/live2d-manifest'
import { syncLocalLive2d } from '../maintenance/sync-local-live2d'
const { createLive2dRouter }: typeof import('../../routes/live2d') = require('../../routes/live2d')
const { validateChatBody }: typeof import('../../routes/chat') = require('../../routes/chat')

test('local model import repairs optional entries, keeps source bytes, is idempotent and rejects broken core assets', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-import-'))
  const write = (file: string, data: unknown) => {
    const target = path.join(root, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, typeof data === 'string' ? data : JSON.stringify(data))
  }
  const base = 'assets/live2d-candidates/fixture/'
  const candidate = { id: 'fixture', name: 'Fixture', shortName: 'F', directory: 'fixture', entry: 'model.model3.json',
    persona: 'Fixture identity only', greeting: 'Hello', dropExpressions: ['absent.exp3.json'] }
  const manifest = { Version: 3, FileReferences: { Moc: 'core.moc3', Textures: ['texture.png'],
    Expressions: [{ Name: 'absent', File: 'absent.exp3.json' }] } }
  try {
    write('data/live2d-candidates.json', [candidate])
    write(base + candidate.entry, manifest)
    write(base + 'core.moc3', 'MOC3fixture')
    write(base + 'texture.png', 'image fixture')
    write(base + '喜.exp3.json', { Type: 'Live2D Expression', Parameters: [] })
    write(base + 'SOURCE.md', 'Local fixture attribution')
    assert.equal(importCandidates(root)[0].state, 'preview')
    assert.equal(fs.existsSync(localLive2dRoot(root)), false)
    assert.equal(importCandidates(root, true)[0].state, 'imported')
    assert.equal(importCandidates(root, true)[0].state, 'unchanged')
    write('data/live2d-candidates.json', [{ ...candidate, greeting: 'Updated greeting' }])
    assert.throws(() => importCandidates(root, true))
    assert.equal(importCandidates(root, true, undefined, true)[0].state, 'refreshed')
    assert.ok(fs.readdirSync(localLive2dRoot(root)).some(name => name.startsWith('.previous-fixture-')))
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, base, candidate.entry), 'utf8')), manifest)
    const localRoot = localLive2dRoot(root)
    const entries = readLocalCompanions(localRoot)
    assert.equal(entries.length, 1)
    // A retired model remains on disk but is absent from both discovery and serving.
    const retired = path.join(localRoot, 'raiden_shogun')
    fs.cpSync(path.join(localRoot, 'fixture'), retired, { recursive: true })
    const receipt = JSON.parse(fs.readFileSync(path.join(retired, 'companion.json'), 'utf8'))
    receipt.character.id = 'raiden_shogun'
    fs.writeFileSync(path.join(retired, 'companion.json'), JSON.stringify(receipt))
    assert.deepEqual(readLocalCompanions(localRoot).map(item => item.character.id), ['fixture'])
    const desktopModels = path.join(root, 'desktop-profile/live2d-imports')
    assert.equal(syncLocalLive2d(localRoot, desktopModels)[0].state, 'preview')
    assert.equal(fs.existsSync(desktopModels), false)
    assert.equal(syncLocalLive2d(localRoot, desktopModels, true)[0].state, 'synced')
    assert.equal(syncLocalLive2d(localRoot, desktopModels, true)[0].state, 'unchanged')
    assert.equal(readLocalCompanions(desktopModels)[0].character.id, 'fixture')
    assert.equal(entries[0].avatar.expressions[0].id, '喜')
    const app = express()
    app.use(createLive2dRouter({ ROOT_DIR: root }).router)
    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    const url = 'http://127.0.0.1:' + (server.address() as import('node:net').AddressInfo).port
    try {
      const catalog = await (await fetch(url + '/api/live2d-companions')).json()
      assert.equal(catalog[0].character.id, 'fixture')
      assert.equal((await fetch(url + entries[0].avatar.modelPath)).status, 200)
      assert.equal((await fetch(url + '/api/live2d-local/fixture/companion.json')).status, 404)
      assert.equal((await fetch(url + '/api/live2d-local/raiden_shogun/' + entries[0].manifest)).status, 404)
      const remote = { 'x-forwarded-for': '203.0.113.10' }
      assert.deepEqual(await (await fetch(url + '/api/live2d-companions', { headers: remote })).json(), [])
      assert.equal((await fetch(url + entries[0].avatar.modelPath, { headers: remote })).status, 404)
      assert.equal((await fetch(url + '/api/live2d-model/fixture/compact', { headers: remote })).status, 404)
      const body = { character: 'fixture', messages: [{ role: 'user', content: 'hi' }] }
      assert.ok(validateChatBody(body).error)
      const allowed = validateChatBody(body, entries[0].character.personaPrompt)
      assert.ok(allowed.value?.messages[0].content.includes('Fixture identity only'))
      assert.ok(!allowed.value?.messages[0].content.includes('绫地宁宁'))
    } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
    const imported = path.join(localRoot, 'fixture')
    for (const reference of ['../fixture/core.moc3', '%2e%2e/core.moc3', 'https://example.test/model', '']) {
      assert.throws(() => modelFile(imported, reference))
    }
    fs.unlinkSync(path.join(imported, 'core.moc3'))
    assert.equal(readLocalCompanions(localRoot).length, 0)
    assert.throws(() => importCandidates(root, true))
    assert.throws(() => modelFormat({ Version: 3, FileReferences: {} }))
    assert.equal(modelFormat({ model: 'rem.moc', textures: ['t.png'] }), 'cubism2')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
