import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { build } from 'esbuild'
import { resolve } from 'node:path'

type Fixture = {
  initializePlatform(busy: () => boolean): Promise<() => void>
  startArtworkSession(): Promise<void>
  withArtworkStaging<T>(work: () => Promise<T>): Promise<T>
  withArtworkCleanup<T>(work: () => Promise<T>): Promise<T>
  useBackup(flash: (message: string) => void): { cleanOrphanImages(): Promise<number> }
  imgPutRecord(record: { id: string; blob: Blob }): Promise<string>
  imgList(): Promise<Array<{ id: string }>>
  kvSet(key: string, value: unknown): Promise<void>
  registerMaintenanceParticipant(flush: () => Promise<void>): () => void
  maintenanceFrozen(): boolean
  setMaintenancePhase(phase: 'idle' | 'preparing' | 'sealed'): void
  effectScope(): { run<T>(work: () => T): T | undefined; stop(): void }
  refreshDesktopRuntime(): Promise<void>
  artworkRepository: { purgeTrash(entries: Array<{ id: string; deletedAt: number }>): Promise<{ purged: number }> }
}
declare global {
  interface Window {
    cleanupFixture: Fixture
    cleanupBusy: boolean
    cleanupEpoch: string
    cleanupBarrier?: { entered: boolean; release(): void; done?: Promise<void>; remove?(): void }
    cleanupScope?: ReturnType<Fixture['effectScope']>
    cleanupPending?: Promise<{ count: number; messages: string[] }>
  }
}

let source = ''
test.beforeAll(async () => {
  const root = resolve(__dirname, '../..')
  const result = await build({
    stdin: { resolveDir: root, contents: [
      "export * from './src/storage/artworkSession.ts';",
      "export * from './src/platform/initializePlatform.ts';",
      "export * from './src/platform/maintenanceParticipants.ts';",
      "export * from './src/platform/desktop/runtime.ts';",
      "export * from './src/storage/artworkRepository.ts';",
      "export * from './src/composables/useImageStore.ts';",
      "export * from './src/composables/useKVStore.ts';",
      "export * from './src/composables/useBackup.ts';",
      "export { effectScope } from 'vue';",
    ].join('\n') },
    bundle: true, write: false, format: 'iife', globalName: 'cleanupFixture', platform: 'browser',
    alias: { '@': resolve(root, 'src') }, logLevel: 'silent',
    define: { 'import.meta.env.MODE': '"test"' },
    plugins: [{ name: 'confirmation-fixture', setup(builder) {
      // A neutral document shell has no ConfirmDialog host. Accept exactly the
      // product confirmation here; its rendered interaction is tested separately.
      builder.onResolve({ filter: /composables\/useConfirm(\.ts)?$/ }, () => ({ path: 'confirmation', namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const confirmAction = async () => true', loader: 'js' }))
    } }],
  })
  source = result.outputFiles[0].text
})
test.beforeEach(async ({ context }) => {
  await context.route('**/__desktop-cleanup', route => route.fulfill({ contentType: 'text/html',
    body: '<!doctype html><title>Isolated desktop cleanup</title><div id="app"><input aria-label="fixture input"></div><script src="/__desktop-cleanup.js"></script>' }))
  await context.route('**/__desktop-cleanup.js', route => route.fulfill({ contentType: 'application/javascript', body: source }))
})

async function enter(page: Page, role?: 'atelier' | 'companion' | 'companion-chat', profile = 'a'.repeat(64)) {
  if (role) await page.addInitScript(({ role, profile }) => {
    window.cleanupBusy = false; window.cleanupEpoch = 'cleanup-runtime-fixture'
    Object.assign(window, { __TAURI__: {
      core: { invoke: async () => ({ protocolVersion: 1, windowRole: role, windowId: role,
        sourceProfileId: 'profile-' + profile, sourceOrigin: location.origin, bundledUiAvailable: false,
        connection: 'ready', runtime: { origin: location.origin, protocolVersion: 1, ownership: 'managed', runtimeEpoch: window.cleanupEpoch, workspace: null } }) },
      event: { listen: async () => () => {} },
    } })
  }, { role, profile })
  await page.goto('/__desktop-cleanup')
  await page.waitForFunction(() => Boolean(window.cleanupFixture))
  await page.evaluate(async desktop => {
    if (desktop) await window.cleanupFixture.initializePlatform(() => window.cleanupBusy)
    await window.cleanupFixture.startArtworkSession()
  }, Boolean(role))
}
async function windows(context: BrowserContext, page: Page) {
  const companion = await context.newPage(), chat = await context.newPage()
  await Promise.all([enter(page, 'atelier'), enter(companion, 'companion'), enter(chat, 'companion-chat')])
  await page.bringToFront()
  return { companion, chat }
}
async function seed(page: Page, ids = ['orphan']) {
  await page.evaluate(async ids => {
    for (const id of ids) await window.cleanupFixture.imgPutRecord({ id, blob: new Blob(['neutral fixture'], { type: 'image/png' }) })
  }, ids)
}
async function cleanup(page: Page) {
  return page.evaluate(async () => {
    const messages: string[] = []
    const count = await window.cleanupFixture.useBackup(message => messages.push(message)).cleanOrphanImages()
    return { count, messages }
  })
}
async function thawed(pages: Page[], documentCount: number) {
  for (const page of pages) await expect.poll(() => page.evaluate(() => window.cleanupFixture.maintenanceFrozen())).toBe(false)
  await expect.poll(() => pages[0].evaluate(async () => ((await navigator.locks.query()).held ?? [])
    .filter(lock => lock.name === 'huiyu-artwork-documents').length)).toBe(documentCount)
}
async function holdFlush(page: Page) {
  await page.evaluate(() => {
    let release!: () => void
    const done = new Promise<void>(resolve => { release = resolve })
    const barrier = { entered: false, release, remove: undefined as (() => void) | undefined }
    window.cleanupBarrier = barrier
    barrier.remove = window.cleanupFixture.registerMaintenanceParticipant(async () => { barrier.entered = true; await done })
  })
}
async function releaseFlush(page: Page) {
  await page.evaluate(() => { window.cleanupBarrier?.remove?.(); window.cleanupBarrier?.release() })
}

test('one desktop workspace with two auxiliary documents can clean while protecting their drafts and trash', async ({ context, page }) => {
  const { companion, chat } = await windows(context, page)
  await seed(page, ['orphan', 'companion-draft', 'chat-draft', 'trash-image'])
  await companion.evaluate(() => sessionStorage.setItem('aics_video_draft_v1', JSON.stringify({ imageId: 'companion-draft' })))
  await chat.evaluate(() => sessionStorage.setItem('aics_pb_temp_result_v1', JSON.stringify({ imageId: 'chat-draft' })))
  await page.evaluate(() => window.cleanupFixture.kvSet('aics_pb_trash', [{ id: 'trash', deletedAt: 1,
    historyEntries: [{ id: 'trash', image_id: 'trash-image' }], imageIds: ['trash-image'], projectRefs: [] }]))
  expect(await cleanup(page)).toMatchObject({ count: 1 })
  expect(await page.evaluate(async () => (await window.cleanupFixture.imgList()).map(image => image.id).sort()))
    .toEqual(['chat-draft', 'companion-draft', 'trash-image'])
  await thawed([page, companion, chat], 3)
  await chat.evaluate(() => sessionStorage.setItem('after-cleanup', 'writes-resumed'))
})

test('manual trash clearing uses the same sibling coordination and preserves a hidden draft original', async ({ context, page }) => {
  const { companion, chat } = await windows(context, page)
  await seed(page, ['draft-original', 'trash-original'])
  await chat.evaluate(() => sessionStorage.setItem('aics_video_draft_v1', JSON.stringify({ imageId: 'draft-original' })))
  await page.evaluate(() => window.cleanupFixture.kvSet('aics_pb_trash', [
    { id: 'shared', deletedAt: 1, historyEntries: [{ id: 'shared', image_id: 'draft-original' }], imageIds: ['draft-original'], projectRefs: [] },
    { id: 'only-trash', deletedAt: 1, historyEntries: [{ id: 'only-trash', image_id: 'trash-original' }], imageIds: ['trash-original'], projectRefs: [] },
  ]))
  expect(await page.evaluate(() => window.cleanupFixture.artworkRepository.purgeTrash([{ id: 'shared', deletedAt: 1 }, { id: 'only-trash', deletedAt: 1 }]))).toEqual({ purged: 2 })
  expect(await page.evaluate(async () => (await window.cleanupFixture.imgList()).map(image => image.id))).toEqual(['draft-original'])
  await thawed([page, companion, chat], 3)
})

for (const foreign of ['browser', 'different-profile', 'different-epoch'] as const) {
  test(`a ${foreign} document still refuses cleanup`, async ({ context, page }) => {
    const { companion, chat } = await windows(context, page)
    const other = await context.newPage()
    await enter(other, foreign === 'browser' ? undefined : 'companion', foreign === 'different-profile' ? 'b'.repeat(64) : 'a'.repeat(64))
    if (foreign === 'different-epoch') await other.evaluate(async () => { window.cleanupEpoch = 'other-epoch'; await window.cleanupFixture.refreshDesktopRuntime() })
    await seed(page)
    const result = await cleanup(page)
    expect(result.count).toBe(0); expect(result.messages.join(' ')).toContain('未删除图片')
    expect(await page.evaluate(async () => (await window.cleanupFixture.imgList()).map(image => image.id))).toEqual(['orphan'])
    await thawed([page, companion, chat, other], 4)
  })
}

test('busy and malformed auxiliary drafts refuse cleanup and recover without dropping document leases', async ({ context, page }) => {
  const { companion, chat } = await windows(context, page)
  await seed(page)
  await companion.evaluate(() => { window.cleanupBusy = true })
  expect((await cleanup(page)).messages.join(' ')).toContain('未删除图片')
  await thawed([page, companion, chat], 3)
  await companion.evaluate(() => { window.cleanupBusy = false; sessionStorage.setItem('aics_video_draft_v1', '{invalid') })
  expect((await cleanup(page)).count).toBe(0)
  await thawed([page, companion, chat], 3)
  await companion.evaluate(() => sessionStorage.removeItem('aics_video_draft_v1'))
  expect((await cleanup(page)).count).toBe(1)
  await thawed([page, companion, chat], 3)
})

test('a sibling image save keeps its staging lease throughout the gap before publishing a reference', async ({ context, page }) => {
  const { companion, chat } = await windows(context, page)
  await seed(page)
  await companion.evaluate(() => {
    let release!: () => void
    const done = new Promise<void>(resolve => { release = resolve })
    const barrier = { entered: false, release, done: Promise.resolve() }
    window.cleanupBarrier = barrier
    barrier.done = window.cleanupFixture.withArtworkStaging(async () => {
      barrier.entered = true; await done
      await window.cleanupFixture.kvSet('aics_pb_history', [{ id: 'saved', image_id: 'orphan' }])
    })
  })
  await companion.waitForFunction(() => window.cleanupBarrier?.entered)
  expect((await cleanup(page)).count).toBe(0)
  await companion.evaluate(async () => { window.cleanupBarrier!.release(); await window.cleanupBarrier!.done })
  await thawed([page, companion, chat], 3)
  expect((await cleanup(page)).count).toBe(0)
  expect(await page.evaluate(async () => (await window.cleanupFixture.imgList()).map(image => image.id))).toEqual(['orphan'])
})

test('source and sibling drafts stay sealed throughout deletion even after the sibling timeout or another maintenance cancellation', async ({ context, page }) => {
  const { companion, chat } = await windows(context, page)
  await companion.clock.install()
  await page.evaluate(() => {
    let release!: () => void
    const done = new Promise<void>(resolve => { release = resolve })
    const barrier = { entered: false, release, done: Promise.resolve() }
    window.cleanupBarrier = barrier
    barrier.done = window.cleanupFixture.withArtworkCleanup(async () => { barrier.entered = true; await done })
  })
  await page.waitForFunction(() => window.cleanupBarrier?.entered)
  for (const current of [page, companion, chat]) expect(await current.evaluate(() => {
    try { sessionStorage.setItem('aics_video_draft_v1', 'must not write'); return false } catch { return true }
  })).toBe(true)
  await companion.clock.runFor(5100)
  await companion.evaluate(() => { window.cleanupFixture.setMaintenancePhase('preparing'); window.cleanupFixture.setMaintenancePhase('idle') })
  expect(await companion.evaluate(() => window.cleanupFixture.maintenanceFrozen())).toBe(true)
  expect(await companion.evaluate(() => {
    try { localStorage.setItem('aics_pb_last_draft', 'must not write'); return false } catch { return true }
  })).toBe(true)
  await page.evaluate(async () => { window.cleanupBarrier!.release(); await window.cleanupBarrier!.done })
  await thawed([page, companion, chat], 3)
})

for (const interruption of ['abort', 'epoch', 'timeout'] as const) {
  test(`${interruption} while waiting for a sibling thaw preserves originals and ignores its late ACK`, async ({ context, page }) => {
    const { companion, chat } = await windows(context, page)
    await seed(page); await holdFlush(companion)
    if (interruption === 'timeout') await page.clock.install()
    await page.evaluate(() => {
      const messages: string[] = [], scope = window.cleanupFixture.effectScope()
      window.cleanupScope = scope
      const backup = scope.run(() => window.cleanupFixture.useBackup(message => messages.push(message)))!
      window.cleanupPending = backup.cleanOrphanImages().then(count => ({ count, messages }))
    })
    await companion.waitForFunction(() => window.cleanupBarrier?.entered)
    if (interruption === 'abort') await page.evaluate(() => window.cleanupScope!.stop())
    else if (interruption === 'epoch') await page.evaluate(async () => { window.cleanupEpoch = 'new-epoch'; await window.cleanupFixture.refreshDesktopRuntime() })
    else await page.clock.runFor(5100)
    expect((await page.evaluate(() => window.cleanupPending!)).count).toBe(0)
    await releaseFlush(companion)
    await thawed([page, companion, chat], 3)
    expect(await page.evaluate(async () => (await window.cleanupFixture.imgList()).map(image => image.id))).toEqual(['orphan'])
    if (interruption === 'epoch') await page.evaluate(async () => { window.cleanupEpoch = 'cleanup-runtime-fixture'; await window.cleanupFixture.refreshDesktopRuntime() })
    expect((await cleanup(page)).count).toBe(1)
  })
}
