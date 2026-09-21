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
import { addLocalImport, editImportProfile, getImportProfile } from '../../services/live2d-import-editor'
import { inspectUploadBytes } from '../../services/live2d-upload-checks'
const { createLive2dRouter }: typeof import('../../routes/live2d') = require('../../routes/live2d')
const { validateChatBody }: typeof import('../../routes/chat') = require('../../routes/chat')
const textureHeader = (width = 16, height = 16) => {
  const bytes = Buffer.alloc(24)
  Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes)
  bytes.write('IHDR', 12); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20)
  return bytes
}

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

test('local import editor validates files, publishes atomically and protects calibration with revision and byte fingerprints', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-import-editor-'))
  const profile = { schemaVersion: 1, profileId: 'profile-editor', profileVersion: '1.0.0', avatarId: 'avatar-editor', backendCompatibility: ['browser'], parameterBindings: { blink: ['EyeL', 'EyeR'] }, verification: { status: 'needs-confirmation' } }
  const metadata = { id: 'editor', name: 'Editor fixture', persona: 'Neutral fixture', author: 'Fixture', terms: 'Test only', entryPath: 'nested/model.model3.json', profile }
  const uploads = [
    { path: metadata.entryPath, bytes: Buffer.from(JSON.stringify({ Version: 3, FileReferences: { Moc: 'core.moc3', Textures: ['texture.png'] } })) },
    { path: 'nested/core.moc3', bytes: Buffer.from('MOC3fixture') },
    { path: 'nested/texture.png', bytes: textureHeader() },
  ]
  try {
    const imported = addLocalImport(root, metadata, uploads)
    assert.equal(readLocalCompanions(root).length, 1)
    assert.throws(() => addLocalImport(root, metadata, uploads), /exists/)
    const calibrated = { ...profile, parameterBindings: { ...profile.parameterBindings, mouth: { id: 'Mouth', scale: 1, range: [0, 2], closed: 0.2, open: 1.8 }, blinkCalibration: { EyeL: { range: [0, 1], closed: 0, open: 1 } } } }
    const saved = editImportProfile(root, 'editor', { ...imported, profile: calibrated }, 'save')
    assert.notEqual(saved.revision, imported.revision)
    assert.equal(saved.fingerprint, imported.fingerprint)
    assert.throws(() => editImportProfile(root, 'editor', { ...imported, profile }, 'save'), /changed/)
    const rolled = editImportProfile(root, 'editor', saved, 'rollback')
    assert.deepEqual(rolled.profile, profile)
    assert.throws(() => editImportProfile(root, 'editor', { ...rolled, profile: { ...calibrated, parameterBindings: { mouth: { id: 'Mouth', scale: 1, range: [0, 1], closed: 2, open: 0 } } } }, 'save'), /endpoints/)
    assert.equal(getImportProfile(root, 'editor').revision, rolled.revision)
    fs.appendFileSync(path.join(root, 'editor/nested/core.moc3'), 'changed')
    assert.throws(() => editImportProfile(root, 'editor', { ...rolled, profile }, 'save'), /changed/)
    const current = getImportProfile(root, 'editor')
    editImportProfile(root, 'editor', current, 'disable')
    assert.equal(readLocalCompanions(root).length, 0)
    assert.ok(fs.existsSync(path.join(root, 'editor/nested/core.moc3')))
    for (const invalid of ['../escape', 'nested/CON.png', 'nested/texture.png.', 'nested/%2e.png', 'nested\\bad.png']) {
      assert.throws(() => addLocalImport(root, { ...metadata, id: 'bad' }, [...uploads, { path: invalid, bytes: Buffer.from('bad') }]))
    }
    assert.throws(() => addLocalImport(root, { ...metadata, id: 'bad' }, [...uploads, { path: 'nested/CORE.moc3', bytes: Buffer.from('bad') }]), /Duplicate/)
    assert.throws(() => addLocalImport(root, { ...metadata, id: 'bad' }, uploads.slice(0, 2)), /limits/)
    const missing = uploads.map(file => file.path.endsWith('core.moc3') ? { ...file, path: 'nested/wrong.moc3' } : file)
    assert.throws(() => addLocalImport(root, { ...metadata, id: 'bad', profile: { ...profile, profileId: 'profile-bad', avatarId: 'avatar-bad' } }, missing), /Missing/)
    assert.equal(fs.existsSync(path.join(root, 'bad')), false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('import API accepts multipart on direct local requests and refuses forwarded/cross-site writes before parsing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-import-route-'))
  const app = express()
  app.use(createLive2dRouter({ ROOT_DIR: root }).router)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const url = 'http://127.0.0.1:' + (server.address() as import('node:net').AddressInfo).port
  try {
    for (const headers of [{ 'x-forwarded-for': '203.0.113.1' }, { origin: 'https://foreign.invalid' }] as Record<string, string>[]) {
      assert.equal((await fetch(url + '/api/live2d-import', { method: 'POST', headers })).status, 403)
    }
    const form = new FormData()
    const profile = { schemaVersion: 1, profileId: 'route-profile', profileVersion: '1', avatarId: 'route-avatar', backendCompatibility: ['browser'], parameterBindings: {}, verification: { status: 'needs-confirmation' } }
    form.set('metadata', JSON.stringify({ id: 'route', name: 'Fixture', persona: 'Fixture', author: 'Fixture', terms: 'Test', entryPath: 'fixture.model3.json', profile }))
    form.set('paths', JSON.stringify(['fixture.model3.json', 'core.moc3', 'texture.png']))
    form.append('files', new Blob([JSON.stringify({ Version: 3, FileReferences: { Moc: 'core.moc3', Textures: ['texture.png'] } })]), 'fixture.model3.json')
    form.append('files', new Blob(['MOC3fixture']), 'core.moc3')
    form.append('files', new Blob([new Uint8Array(textureHeader())]), 'texture.png')
    const response = await fetch(url + '/api/live2d-import', { method: 'POST', body: form })
    assert.equal(response.status, 201, await response.clone().text())
    const imported = await response.json()
    const save = await fetch(url + '/api/live2d-import/route', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...imported, profile: { ...profile, parameterBindings: { focus: ['ANGLE_X'] } } }) })
    assert.equal(save.status, 200, await save.clone().text())
    const saved = await save.json()
    assert.equal((await fetch(url + '/api/live2d-import/route/rollback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(saved) })).status, 200)
    assert.equal((await fetch(url + '/api/live2d-import/route', { headers: { 'x-forwarded-for': '203.0.113.1' } })).status, 403)
    const tooLarge = await fetch(url + '/api/live2d-import/route', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ padding: 'x'.repeat(100000) }) })
    assert.equal(tooLarge.status, 413)
    assert.match(tooLarge.headers.get('content-type') || '', /application\/json/)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('upload byte validation rejects oversized JSON, unsafe nesting, invalid texture dimensions and moc headers', () => {
  assert.throws(() => inspectUploadBytes([{ path: 'big.json', bytes: Buffer.alloc(4 * 1024 * 1024 + 1) }]), /4 MiB/)
  assert.throws(() => inspectUploadBytes([{ path: 'deep.json', bytes: Buffer.from('{"x":'.repeat(34) + '0' + '}'.repeat(34)) }]), /depth/)
  assert.throws(() => inspectUploadBytes([{ path: 'bad.json', bytes: Buffer.from('{"constructor":{}}') }]), /key/)
  assert.throws(() => inspectUploadBytes([{ path: 'texture.png', bytes: textureHeader(8193) }]), /dimensions/)
  assert.throws(() => inspectUploadBytes([{ path: 'texture.png', bytes: textureHeader(8192, 8192) }]), /dimensions/)
  assert.throws(() => inspectUploadBytes([{ path: 'bad.moc3', bytes: Buffer.from('notmoc3') }]), /header/)
})

test('imports retain UserData and expression metadata, isolate identities, sanitize viewer extensions and bind every uploaded file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-import-review-'))
  const profile = { schemaVersion: 1, profileId: 'review-profile', profileVersion: '1', avatarId: 'review-avatar', backendCompatibility: ['browser'], parameterBindings: {}, verification: { status: 'verified' } }
  const metadata = { id: 'review', name: 'Fixture', persona: 'Fixture', author: 'Fixture', terms: 'Test', entryPath: 'model.model3.json', profile }
  const model = { Version: 3, Controllers: { unsafe: true }, Options: { unsafe: true }, FileReferences: { Moc: 'core.moc3', Textures: ['texture.png'], UserData: 'userdata.json', Expressions: [{ Name: 'Smile', File: 'smile.exp3.json' }] } }
  const files = [
    { path: metadata.entryPath, bytes: Buffer.from(JSON.stringify(model)) },
    { path: 'core.moc3', bytes: Buffer.from('MOC3fixture') }, { path: 'texture.png', bytes: textureHeader() },
    { path: 'userdata.json', bytes: Buffer.from('{}') },
    { path: 'smile.exp3.json', bytes: Buffer.from('{"Parameters":[{"Id":"Smile","Value":1}]}') },
    { path: 'unused.json', bytes: Buffer.from('{}') },
  ]
  try {
    const distinct = { ...metadata, id: 'invalid', profile: { ...profile, profileId: 'invalid-profile', avatarId: 'invalid-avatar' } }
    assert.throws(() => addLocalImport(root, distinct, files.filter(file => file.path !== 'userdata.json')), /Missing/)
    assert.throws(() => addLocalImport(root, distinct, files.map(file => file.path === metadata.entryPath ? { ...file, bytes: Buffer.from(JSON.stringify({ ...model, Version: 2 })) } : file)), /Only Cubism3/)
    const state = addLocalImport(root, metadata, files)
    assert.equal(state.profile.verification.status, 'needs-confirmation')
    const local = readLocalCompanions(root)[0]
    assert.ok(local.files.includes('userdata.json'))
    assert.deepEqual(local.avatar.expressions, [{ id: 'Smile', label: 'Smile', parameterIds: ['Smile'] }])
    assert.equal(local.character.presentation.image, '')
    const published = JSON.parse(fs.readFileSync(path.join(root, 'review', local.manifest), 'utf8'))
    assert.equal(published.Controllers, undefined); assert.equal(published.Options, undefined)
    for (const changed of ['unused.json', metadata.entryPath]) {
      const before = getImportProfile(root, 'review')
      fs.appendFileSync(path.join(root, 'review', changed), ' ')
      assert.notEqual(getImportProfile(root, 'review').fingerprint, before.fingerprint)
      assert.throws(() => editImportProfile(root, 'review', { ...before, profile }, 'save'), /changed/)
    }
    assert.throws(() => addLocalImport(root, { ...metadata, id: 'collision' }, files), /already registered/)
    assert.throws(() => addLocalImport(root, { ...metadata, id: 'builtin', profile: { ...profile, avatarId: 'avatar-nene-default' } }, files), /already registered/)
    const receiptFile = path.join(root, 'review', 'companion.json')
    const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'))
    receipt.avatar.characterId = 'other'
    fs.writeFileSync(receiptFile, JSON.stringify(receipt))
    assert.throws(() => getImportProfile(root, 'review'), /identity/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
