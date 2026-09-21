import { test, expect, type Page } from '@playwright/test'
import { build } from 'esbuild'
import { resolve } from 'node:path'
type ArchiveFixture = { ready: Promise<void>; refresh(): Promise<void>; save(): Promise<boolean>; clear(character?: string): void; add(character: string, messages: Array<{ mid: string; content: string; role: 'user'; stopped: boolean }>): void; archive: { value: { archived: Record<string, Array<{ mid: string }>> } } }

declare global {
  interface Window {
    chatArchiveFixture: ArchiveFixture
    archiveCommit?: Promise<boolean>
    archiveBarrier?: { entered: boolean; release(): void; done: Promise<void> }
    archiveRestore(text: string, replace: boolean): Promise<void>
    archiveReset(): Promise<{ failed: string[] }>
  }
}
let sourceBundle: string
test.beforeAll(async () => {
  const root = resolve(__dirname, '../..')
  const result = await build({
    stdin: { contents: `import { useChatArchiveStorage } from './src/composables/chat/useChatArchiveStorage.ts';
      import { restoreBackupData } from './src/storage/backupRestore.ts';
      import { normalizeBackup } from './src/utils/backupCore.ts';
      import { clearStoredChatContent } from './src/utils/chatReset.ts';
      window.archiveRestore = (text, replace) => restoreBackupData(normalizeBackup({ data: { history: [], projects: [], settings: { aics_chat_archive_v1: text } }, images: [] }), replace);
      window.archiveReset = clearStoredChatContent;
      window.chatArchiveFixture = useChatArchiveStorage(['nene', 'natsume'], () => true, console.error);`, resolveDir: root },
    bundle: true, write: false, format: 'iife', platform: 'browser',
    alias: { '@': resolve(root, 'src') }, logLevel: 'silent',
  })
  sourceBundle = result.outputFiles[0].text
})
test.beforeEach(async ({ context }) => {
  await context.route('**/__chat-archive-fixture', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><script src="/__chat-archive-fixture.js"></script>',
  }))
  await context.route('**/__chat-archive-fixture.js', route => route.fulfill({ contentType: 'application/javascript', body: sourceBundle }))
})
async function enter(page: Page) {
  await page.goto('/__chat-archive-fixture')
  await page.waitForFunction(() => Boolean(window.chatArchiveFixture))
  await page.evaluate(() => window.chatArchiveFixture.ready)
}
async function add(page: Page, id: string, character = 'nene') {
  await page.evaluate(({ id, character }) => {
    window.chatArchiveFixture.add(character, [{ mid: id, content: id, role: 'user', stopped: false }])
  }, { id, character })
}
async function ids(page: Page, character = 'nene') {
  return page.evaluate(async character => {
    await window.chatArchiveFixture.refresh()
    return window.chatArchiveFixture.archive.value.archived[character].map(item => item.mid)
  }, character)
}

test('real two-page lock contention preserves concurrent additions and clear defeats a queued stale addition', async ({ context }) => {
  const a = await context.newPage(), b = await context.newPage(), barrier = await context.newPage()
  await Promise.all([enter(a), enter(b), enter(barrier)])
  await Promise.all([add(a, 'first'), add(b, 'second')])
  expect(await Promise.all([a.evaluate(() => window.chatArchiveFixture.save()), b.evaluate(() => window.chatArchiveFixture.save())])).toEqual([true, true])
  expect((await ids(a)).sort()).toEqual(['first', 'second'])
  await add(a, 'keep', 'natsume'); await a.evaluate(() => window.chatArchiveFixture.save())
  await add(b, 'delayed')
  await barrier.evaluate(() => {
    const state: NonNullable<Window['archiveBarrier']> = { entered: false, release: () => {}, done: Promise.resolve() }
    window.archiveBarrier = state
    state.done = (async () => { await navigator.locks.request('aics_chat_archive_v1', async () => new Promise<void>(resolve => {
      state.entered = true; state.release = resolve
    })) })()
  })
  await barrier.waitForFunction(() => window.archiveBarrier?.entered)
  await a.evaluate(() => { window.chatArchiveFixture.clear('nene'); window.archiveCommit = window.chatArchiveFixture.save() })
  // Observe the actual lock queue before scheduling the stale writer behind clear.
  await barrier.waitForFunction(async () => (await navigator.locks.query()).pending?.length === 1)
  await b.evaluate(() => { window.archiveCommit = window.chatArchiveFixture.save() })
  await barrier.waitForFunction(async () => (await navigator.locks.query()).pending?.length === 2)
  await barrier.evaluate(() => window.archiveBarrier!.release())
  expect(await Promise.all([a.evaluate(() => window.archiveCommit), b.evaluate(() => window.archiveCommit)])).toEqual([true, true])
  expect(await ids(b)).toEqual([])
  expect(await ids(b, 'natsume')).toEqual(['keep'])
  await add(b, 'after-clear'); await b.evaluate(() => window.chatArchiveFixture.save())
  expect(await ids(a)).toEqual(['after-clear'])
  await a.reload(); await a.waitForFunction(() => Boolean(window.chatArchiveFixture))
  expect(await ids(a)).toEqual(['after-clear'])
})

test('real two-page clears preserve the other character and pending new-epoch additions', async ({ context }) => {
  const a = await context.newPage(), b = await context.newPage()
  await Promise.all([enter(a), enter(b)])
  await add(a, 'old'); await add(a, 'other-old', 'natsume'); await a.evaluate(() => window.chatArchiveFixture.save())
  await a.evaluate(() => window.chatArchiveFixture.clear('nene'))
  await add(a, 'new')
  await b.evaluate(() => window.chatArchiveFixture.clear('natsume'))
  await Promise.all([a.evaluate(() => window.chatArchiveFixture.save()), b.evaluate(() => window.chatArchiveFixture.save())])
  expect(await ids(b)).toEqual(['new'])
  expect(await ids(a, 'natsume')).toEqual([])
})

test('legacy migration, backup replacement and global reset cannot replay an old source or pending writer', async ({ context }) => {
  const a = await context.newPage(), b = await context.newPage()
  await enter(a)
  await a.evaluate(() => localStorage.setItem('aics_chat_archive_v1', JSON.stringify({ version: 1, archived: { nene: [{ mid: 'legacy', role: 'user', content: 'legacy' }], unavailable_model: [{ mid: 'private', role: 'user', content: 'private' }] } })))
  await a.reload(); await a.evaluate(() => window.chatArchiveFixture.ready)
  await enter(b)
  await Promise.all([add(a, 'a'), add(b, 'b')])
  await Promise.all([a.evaluate(() => window.chatArchiveFixture.save()), b.evaluate(() => window.chatArchiveFixture.save())])
  expect((await ids(a)).sort()).toEqual(['a', 'b', 'legacy'])
  expect(await ids(a, 'unavailable_model')).toEqual(['private'])
  await add(b, 'pending-old')
  await a.evaluate(() => window.archiveRestore(JSON.stringify({ version: 1, archived: { nene: [{ mid: 'restored', role: 'user', content: 'restored' }], unavailable_model: [{ mid: 'restored-private', role: 'user', content: 'private' }] } }), true))
  await b.evaluate(() => window.chatArchiveFixture.save())
  expect(await ids(a)).toEqual(['restored'])
  await a.evaluate(() => window.archiveRestore(JSON.stringify({ version: 1, archived: { nene: [{ mid: 'merged', role: 'user', content: 'merged' }] } }), false))
  expect(await ids(b)).toEqual(['restored', 'merged'])
  expect(await ids(b, 'unavailable_model')).toEqual(['restored-private'])
  await add(b, 'pending-reset')
  expect(await a.evaluate(() => window.archiveReset())).toEqual({ failed: [] })
  await b.evaluate(() => window.chatArchiveFixture.save())
  await a.reload(); await a.evaluate(() => window.chatArchiveFixture.ready)
  expect(await ids(a)).toEqual([])
  expect(await ids(a, 'unavailable_model')).toEqual([])
})
