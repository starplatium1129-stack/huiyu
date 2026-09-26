import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'
import { chromium } from '@playwright/test'
import { openWorkspaceEngine } from '../../server/workspace/engine.js'
import type { WorkspaceCommand } from '../../server/workspace/types'

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'huiyu-profile-windows-'))
const workspace = openWorkspaceEngine({ root: workspaceRoot, workspaceId: 'profile-window-fixture', writerEpoch: 'fixture', create: true })
const principal = { workspaceId: 'profile-window-fixture', principalId: 'fixture', protocolVersion: 1 as const }
const chatBase = { version: 3, historiesRevision: 0, historiesRevisions: { nene: 0 }, histories: { nene: [{ mid: 'base', role: 'user', content: 'base', stopped: false }] }, settings: {} }
await workspace.execute({ kind: 'profile.saveSetting', operationId: 'seed-theme', key: 'aics_theme', value: 'dark', expectedRevision: null }, principal)
await workspace.execute({ kind: 'profile.saveChatRecord', operationId: 'seed-chat', key: 'aics_chat_v1', value: JSON.stringify(chatBase), expectedRevision: null, expectedReset: '' }, principal)
let revisionConflicts = 0

const reserve = net.createServer()
await new Promise<void>(resolve => reserve.listen(0, '127.0.0.1', resolve))
const reserved = reserve.address()
if (!reserved || typeof reserved === 'string') throw new Error('Fixture port reservation failed')
await new Promise<void>(resolve => reserve.close(() => resolve()))
const server = await createServer({ configFile: false, appType: 'custom', optimizeDeps: { noDiscovery: true, entries: [] },
  server: { host: '127.0.0.1', port: reserved.port, strictPort: true, watch: null } })
server.middlewares.use((request, response, next) => {
  if (request.url === '/fixture-profile') {
    void (async () => {
      try {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const result = await workspace.execute(JSON.parse(Buffer.concat(chunks).toString()) as WorkspaceCommand, principal)
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ result }))
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'FIXTURE_ERROR'
        if (code === 'REVISION_CONFLICT') revisionConflicts++
        response.statusCode = 409; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ code }))
      }
    })()
    return
  }
  if (request.url !== '/fixture') { next(); return }
  response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Isolated migration fixture</title>')
})
await server.listen()
const address = server.httpServer!.address()
if (!address || typeof address === 'string') throw new Error('Fixture server did not bind a port')
const origin = `http://127.0.0.1:${address.port}`
const executablePath = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe']
  .find(file => fs.existsSync(file))
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
try {
  const context = await browser.newContext()
  const first = await context.newPage(), second = await context.newPage()
  await Promise.all([first.goto(`${origin}/fixture`), second.goto(`${origin}/fixture`)])
  for (const [page, id] of [[first, 'main'], [second, 'chat']] as const) await page.evaluate(async windowId => {
    const module = await import(String('/src/platform/web/migrationBarrier.ts'))
    module.initializeMigrationParticipant({ windowId })
    sessionStorage.setItem('aics_video_draft_v1', JSON.stringify({ fixture: windowId }))
  }, id)
  const frozen = first.evaluate(async () => {
    const module = await import(String('/src/platform/web/migrationBarrier.ts'))
    return module.freezeMigrationSource(async (snapshot: { windowIds: string[]; sessions: Record<string, Record<string, string>> }) => {
      Object.assign(window, { fixtureFrozen: true })
      await new Promise<void>(resolve => Object.assign(window, { fixtureRelease: resolve }))
      return snapshot
    })
  })
  await first.waitForFunction(() => Reflect.get(window, 'fixtureFrozen') === true)
  const blocked = await second.evaluate(async () => {
    const { kvSet } = await import(String('/src/composables/useKVStore.ts'))
    const { imgPut } = await import(String('/src/composables/useImageStore.ts'))
    const blocked: string[] = []
    try { localStorage.setItem('aics_theme', 'light') } catch { blocked.push('local') }
    try { sessionStorage.setItem('aics_video_draft_v1', 'changed') } catch { blocked.push('session') }
    try { await kvSet('aics_pb_history', []) } catch { blocked.push('kv') }
    try { await imgPut(new Blob(['fixture'], { type: 'image/png' })) } catch { blocked.push('media') }
    return blocked
  })
  assert.deepEqual(blocked, ['local', 'session', 'kv', 'media'])
  await first.evaluate(() => Reflect.get(window, 'fixtureRelease')())
  const snapshot = await frozen
  assert.deepEqual(snapshot.windowIds, ['chat', 'main'])
  assert.match(snapshot.sessions.chat.aics_video_draft_v1, /chat/)
  assert.match(snapshot.sessions.main.aics_video_draft_v1, /main/)
  await second.evaluate(async () => {
    const { kvSet } = await import(String('/src/composables/useKVStore.ts'))
    localStorage.setItem('aics_theme', 'light')
    await kvSet('aics_pb_history', [{ id: 1, image_id: 'missing-fixture-original', future: true }])
    localStorage.setItem('aics_chat_v1', '{"settings":{"authorization":"do-not-export-fixture"}}')
    localStorage.setItem('unregistered-fixture-key', 'preserve-source')
  })
  const exported = await first.evaluate(async () => {
    const { exportMigrationSource } = await import(String('/src/platform/web/migrationExport.ts'))
    const { createMigrationDirectoryBackup } = await import(String('/src/platform/web/migrationBackup.ts'))
    const sink = await createMigrationDirectoryBackup(await navigator.storage.getDirectory())
    const records: unknown[] = []
    const envelope = await exportMigrationSource({ sourceProfileId: 'fixture-profile', expectedOrigin: location.origin,
      sink: { ...sink, record: async (id: string, record: unknown) => { records.push(record); await sink.record(id, record) } } })
    return { envelope, records, source: localStorage.getItem('aics_chat_v1') }
  })
  assert.ok(exported.envelope.blockers.some((item: string) => item.startsWith('credential:')))
  assert.ok(exported.envelope.blockers.some((item: string) => item.startsWith('unknown:')))
  assert.equal(JSON.stringify(exported.records).includes('do-not-export-fixture'), false)
  assert.match(exported.source!, /do-not-export-fixture/)
  assert.equal(exported.envelope.source.sourceProfileId, 'fixture-profile')
  for (const [page, id] of [[first, 'main'], [second, 'chat']] as const) await page.evaluate(async windowId => {
    const profile = await import(String('/src/platform/web/profileStorage.ts'))
    const { createProfilePort } = await import(String('/src/platform/web/profilePort.ts'))
    const request = async (command: Record<string, unknown>) => {
      const response = await fetch('/fixture-profile', { method: 'POST', body: JSON.stringify(command) })
      const data = await response.json()
      if (!response.ok) throw Object.assign(new Error(data.code), { code: data.code })
      return data.result
    }
    await profile.activateProfileStorage(createProfilePort(request), windowId)
    Object.assign(window, { fixtureProfile: profile })
  }, id)
  await first.evaluate(async () => {
    const profile = Reflect.get(window, 'fixtureProfile')
    profile.profileLocalStorage.setItem('aics_theme', 'light'); await profile.flushProfileWrites()
    const chat = JSON.parse(profile.profileLocalStorage.getItem('aics_chat_v1'))
    chat.histories.nene.push({ mid: 'first', role: 'user', content: 'first window', stopped: false })
    profile.profileLocalStorage.setItem('aics_chat_v1', JSON.stringify(chat)); await profile.flushProfileWrites()
  })
  const merged = await second.evaluate(async () => {
    const profile = Reflect.get(window, 'fixtureProfile')
    profile.profileLocalStorage.setItem('aics_theme', 'dark'); await profile.flushProfileWrites()
    const chat = JSON.parse(profile.profileLocalStorage.getItem('aics_chat_v1'))
    chat.histories.nene.push({ mid: 'second', role: 'user', content: 'second window', stopped: false })
    profile.profileLocalStorage.setItem('aics_chat_v1', JSON.stringify(chat)); await profile.flushProfileWrites()
    profile.setProfileConnectionBlocked(true)
    profile.profileLocalStorage.setItem('aics_chat_draft_v1:nene', JSON.stringify('offline draft'))
    const pending = profile.hasPendingProfileWrites(), nativeDraft = localStorage.getItem('aics_chat_draft_v1:nene')
    profile.setProfileConnectionBlocked(false); await profile.flushProfileWrites()
    return { pending, nativeDraft, chat: JSON.parse(profile.profileLocalStorage.getItem('aics_chat_v1')) }
  })
  assert.ok(revisionConflicts >= 2)
  assert.deepEqual(merged.chat.histories.nene.map((message: { mid: string }) => message.mid), ['base', 'first', 'second'])
  assert.equal(merged.pending, true); assert.equal(merged.nativeDraft, null)
  await first.evaluate(async () => { const profile = Reflect.get(window, 'fixtureProfile'); await profile.refreshProfileStorage(); await profile.resetProfileChat() })
  const reset = await second.evaluate(async () => {
    const profile = Reflect.get(window, 'fixtureProfile')
    const chat = JSON.parse(profile.profileLocalStorage.getItem('aics_chat_v1'))
    chat.histories.nene.push({ mid: 'unsaved', role: 'user', content: 'unsaved recovery', stopped: false })
    profile.profileLocalStorage.setItem('aics_chat_v1', JSON.stringify(chat)); await profile.flushProfileWrites()
    return { recovery: await profile.exportProfileRecovery().text(), current: JSON.parse(profile.profileLocalStorage.getItem('aics_chat_v1')), reset: profile.profileLocalStorage.getItem('aics_chat_reset_v1') }
  })
  assert.deepEqual(reset.current.histories, {}); assert.ok(reset.reset)
  assert.match(reset.recovery, /unsaved recovery/)
  await context.close()
  console.log('Migration/profile browser: two real windows verified maintenance, independent backup, credential exclusion, SQLite revision rebase, message merge, offline outbox and reset recovery export.')
} finally { await browser.close(); await server.close(); workspace.close(); fs.rmSync(workspaceRoot, { recursive: true, force: true }) }
