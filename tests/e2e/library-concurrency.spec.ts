import { test, expect, type Page } from '@playwright/test'
import { build } from 'esbuild'
import { resolve } from 'node:path'

type LibraryFixture = {
  useChatStorage(): {
    load(): Promise<void>
    setApiSettings(settings: { baseUrl: string; model: string; apiKey: string }): Promise<void>
    state: { settings: { apiKey: string } }
  }
  startArtworkSession(): Promise<void>
  stopArtworkSession(): Promise<void>
  withArtworkStaging<T>(work: () => Promise<T>): Promise<T>
  imgPutRecord(record: { id: string; blob: Blob; created_at: number }): Promise<string>
  imgGetRecord(id: string): Promise<unknown | null>
  saveFixtureArtwork(id: number): Promise<{ id: string | number; imagePresent: boolean } | null>
  useBackup(onFlash: (message: string) => void): { cleanOrphanImages(): Promise<number> }

  artworkRepository: {
    appendArtwork(entry: { id: string; favorite?: boolean }): Promise<unknown[]>
    patchArtwork(id: string, patch: Record<string, unknown>): Promise<unknown>
    softDeleteArtwork(id: string): Promise<unknown>
    restoreArtwork(id: string): Promise<unknown>
    purgeExpiredTrash(): Promise<{ purged: number }>
  }
  ARTWORK_HISTORY_KEY: string
  ARTWORK_TRASH_KEY: string
  kvGet(key: string): Promise<Array<{ id: string; favorite?: boolean }> | null>
  kvSet(key: string, value: unknown): Promise<void>
  restoreBackupData(backup: unknown, replace: boolean): Promise<void>
  normalizeBackup(backup: unknown): unknown
  createTask(summary: { kind: 'image'; title: string; status: 'succeeded' | 'running'; route: string }): string
  updateTask(id: string, patch: { message: string }): void
  flushTaskSummaries(): Promise<void>
  hydrateTasks(): Promise<void>
  useTaskCenter(): { tasks: { value: Array<{ title: string }> }; clearCompleted(): void }
}
declare global {
  interface Window {
    libraryFixture: LibraryFixture
    credentialReadFixture(): Promise<string | null>
    credentialWriteFixture(endpoint: string, secret: string): Promise<void>
    credentialWork?: { store: ReturnType<LibraryFixture['useChatStorage']>; done: Promise<void> }
    libraryBarrier?: { entered: boolean; release(): void; done: Promise<void> }
  }
}

let sourceBundle: string
test.beforeAll(async () => {
  const root = resolve(__dirname, '../..')
  const bundled = await build({
    stdin: { contents: [
      "export * from './src/storage/artworkRepository.ts';",
      "export { ARTWORK_HISTORY_KV_KEY as ARTWORK_HISTORY_KEY, ARTWORK_TRASH_KV_KEY as ARTWORK_TRASH_KEY } from './src/utils/storageKeys.ts';",
      "export { useChatStorage } from './src/composables/chat/useChatStorage.ts';",
      "export * from './src/composables/useKVStore.ts';",
      "export * from './src/storage/backupRestore.ts';",
      "export * from './src/utils/backupCore.ts';",
      "export * from './src/storage/artworkSession.ts';",
      "export * from './src/composables/useBackup.ts';",
      "export * from './src/composables/useImageStore.ts';",
      "export * from './src/composables/useTaskCenter.ts';",
      `import { saveGeneratedArtwork } from './src/application/artwork/saveGeneratedArtwork.ts';
       import { withArtworkStaging } from './src/storage/artworkSession.ts';
       import { imgPut, imgDelete, imgGetRecord } from './src/composables/useImageStore.ts';
       import { artworkRepository } from './src/storage/artworkRepository.ts';
       export async function saveFixtureArtwork(artworkId) {
         const result = await saveGeneratedArtwork({ blob: new Blob(['neutral fixture'], { type: 'image/png' }), prompt: 'Neutral fixture.' }, {
           withStaging: withArtworkStaging, putImage: imgPut, deleteImage: imgDelete,
           cacheThumbnail: async () => {}, measureBlob: async () => ({ width: null, height: null }),
           now: () => 1234, nextId: () => artworkId, appendArtwork: artworkRepository.appendArtwork,
           normalizeArtistStyleIds: () => [],
           resolveLegacyDefaults: () => ({ subject: { kind: 'studio' }, character: 'nene', scene: null, sceneTitle: null, story: '',
             visualDescription: '', seed: -1, emotion: [], shot: null, lighting: null, composition: null, colorMood: null,
             manual_tags: [], lora: null, cfg: 7, steps: 20, sampler: 'euler', scheduler: 'normal', model: 'fixture', size: '',
             hiresFix: false, hiresScale: 2, hiresUpscaler: '', hiresSteps: 0, hiresDenoise: 0.5, faceDetailer: false, project: '', artistStyleIds: [] }),
         });
         return result.ok ? { id: result.entry.id, imagePresent: Boolean(await imgGetRecord(result.entry.image_id)) } : null;
       }`,
    ].join('\n'), resolveDir: root },
    bundle: true, write: false, format: 'iife', globalName: 'libraryFixture', platform: 'browser',
    alias: { '@': resolve(root, 'src') }, logLevel: 'silent',
    plugins: [{
      /**
       * 孤儿清理的确认已从原生 confirm 收编到 useConfirm（2026-09-22 去原生化）。
       * 本夹具只提供独立文档壳，不挂载 App.vue，因此没有 <ConfirmDialog> 宿主，
       * confirmAction 会永远悬置。这里把它桩成「自动接受」——等价于迁移前
       * page.on('dialog', dialog => dialog.accept()) 的语义；弹窗自身的键盘流程、
       * 焦点与对比度由 ConfirmDialog.spec.ts 与 apple-hig-accessibility.spec.ts 覆盖。
       */
      name: 'confirm-stub',
      setup(build) {
        build.onResolve({ filter: /composables\/useConfirm(\.ts)?$/ }, () => ({ path: 'confirm-stub', namespace: 'confirm-stub' }))
        build.onLoad({ filter: /.*/, namespace: 'confirm-stub' }, () => ({
          contents: [
            'export function confirmAction() { return Promise.resolve(true) }',
            'export function resolveConfirm() {}',
            'export function useConfirmState() { return { value: { visible: false } } }',
          ].join('\n'),
          loader: 'js',
        }))
      },
    }],
  })
  sourceBundle = bundled.outputFiles[0].text
})

test.beforeEach(async ({ context }) => {
  // Only the document shell is a fixture. Storage, locks and product source are real.
  await context.route('**/__library-fixture', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><title>Isolated library test</title><script src="/__library-fixture.js"></script>',
  }))
  await context.route('**/__library-fixture.js', route => route.fulfill({ contentType: 'application/javascript', body: sourceBundle }))
})

async function enter(page: Page) {
  await page.goto('/__library-fixture')
  await page.waitForFunction(() => Boolean(window.libraryFixture?.artworkRepository))
}

test('task summaries atomically merge two pages and clearing defeats a stale writer', async ({ context }) => {
  await context.addInitScript(() => Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true }))
  const first = await context.newPage(), second = await context.newPage()
  await Promise.all([enter(first), enter(second)])
  const [completed] = await Promise.all([
    first.evaluate(async () => {
      const id = window.libraryFixture.createTask({ kind: 'image', title: 'Completed A', status: 'succeeded', route: '/gallery' })
      await window.libraryFixture.flushTaskSummaries()
      return id
    }),
    second.evaluate(async () => {
      window.libraryFixture.createTask({ kind: 'image', title: 'Running B', status: 'running', route: '/prompt-builder' })
      await window.libraryFixture.flushTaskSummaries()
    }),
  ])
  await second.evaluate(async () => { await window.libraryFixture.hydrateTasks() })
  expect(await second.evaluate(() => window.libraryFixture.useTaskCenter().tasks.value.map(task => task.title).sort())).toEqual(['Completed A', 'Running B'])
  await second.evaluate(async () => { window.libraryFixture.useTaskCenter().clearCompleted(); await window.libraryFixture.flushTaskSummaries() })
  await first.evaluate(async id => {
    window.libraryFixture.updateTask(id, { message: 'stale update' })
    await window.libraryFixture.flushTaskSummaries()
  }, completed)
  expect(await first.evaluate(() => window.libraryFixture.useTaskCenter().tasks.value.map(task => task.title))).toEqual(['Running B'])
  await Promise.all([first.close(), second.close()])
})
async function ids(page: Page) {
  return page.evaluate(async () => (await window.libraryFixture.kvGet(window.libraryFixture.ARTWORK_HISTORY_KEY) || []).map(item => item.id).sort())
}

async function holdLibrary(page: Page, commitOnRelease = false) {
  await page.evaluate(commit => {
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    const state: NonNullable<Window['libraryBarrier']> = { entered: false, release, done: Promise.resolve() }
    window.libraryBarrier = state
    state.done = Promise.resolve(navigator.locks.request('huiyu-artwork-library', async () => {
      state.entered = true
      await barrier
      if (commit) await window.libraryFixture.kvSet(window.libraryFixture.ARTWORK_HISTORY_KEY, [{ id: 'concurrent' }])
    }))
  }, commitOnRelease)
  await page.waitForFunction(() => window.libraryBarrier?.entered)
}

test('home migration retains legacy data when another page commits before its read', async ({ page, context }) => {
  const writer = await context.newPage()
  await enter(writer)
  await writer.evaluate(() => localStorage.setItem(window.libraryFixture.ARTWORK_HISTORY_KEY, JSON.stringify([{ id: 'legacy' }])))
  await holdLibrary(writer, true)
  try {
    await page.goto('/')
    // Wait for either a queued reader or an unsafe completed migration, without timing guesses.
    await expect.poll(() => writer.evaluate(async () =>
      (await navigator.locks.query()).pending?.some(lock => lock.name === 'huiyu-artwork-library')
      || localStorage.getItem(window.libraryFixture.ARTWORK_HISTORY_KEY) === null,
    )).toBe(true)
  } finally {
    await writer.evaluate(async () => { window.libraryBarrier!.release(); await window.libraryBarrier!.done })
  }
  await expect.poll(() => writer.evaluate(async () => (await navigator.locks.query()).held?.filter(lock => lock.name === 'huiyu-artwork-library').length || 0)).toBe(0)
  expect(await ids(writer)).toEqual(['concurrent'])
  expect(await writer.evaluate(() => JSON.parse(localStorage.getItem(window.libraryFixture.ARTWORK_HISTORY_KEY) || '[]'))).toEqual([{ id: 'legacy' }])
})

test('home legacy migration and a queued append preserve both works', async ({ page, context }) => {
  const writer = await context.newPage()
  await enter(writer)
  await writer.evaluate(() => localStorage.setItem(window.libraryFixture.ARTWORK_HISTORY_KEY, JSON.stringify([{ id: 'legacy' }])))
  await holdLibrary(writer)
  let append = Promise.resolve<string | null>(null)
  try {
    await page.goto('/')
    await expect.poll(() => writer.evaluate(async () => (await navigator.locks.query()).pending?.length || 0)).toBe(1)
    append = writer.evaluate(async () => {
      try {
        await window.libraryFixture.artworkRepository.appendArtwork({ id: 'new-work' })
        return null
      } catch (error) { return String(error) }
    })
    await expect.poll(() => writer.evaluate(async () => (await navigator.locks.query()).pending?.length || 0)).toBe(2)
  } finally {
    await writer.evaluate(async () => { window.libraryBarrier!.release(); await window.libraryBarrier!.done })
  }
  expect(await append).toBeNull()
  expect(await ids(writer)).toEqual(['legacy', 'new-work'])
  expect(await writer.evaluate(() => localStorage.getItem(window.libraryFixture.ARTWORK_HISTORY_KEY))).toBeNull()
})

test('two pages save through the extracted use case with real image storage, IndexedDB and Web Locks', async ({ page, context }) => {
  const other = await context.newPage()
  await Promise.all([enter(page), enter(other)])
  const save = (target: Page, id: number) => target.evaluate(artworkId => window.libraryFixture.saveFixtureArtwork(artworkId), id)
  expect(await Promise.all([save(page, 101), save(other, 202)])).toEqual([{ id: 101, imagePresent: true }, { id: 202, imagePresent: true }])
  expect(await ids(page)).toEqual([101, 202])
  await other.close()
})

test('two pages preserve every concurrent history append in real IndexedDB', async ({ page, context }) => {
  const other = await context.newPage()
  await Promise.all([enter(page), enter(other)])
  for (let round = 0; round < 40; round++) {
    await page.evaluate(() => window.libraryFixture.kvSet(window.libraryFixture.ARTWORK_HISTORY_KEY, []))
    await Promise.all([
      page.evaluate(id => window.libraryFixture.artworkRepository.appendArtwork({ id }), `left-${round}`),
      other.evaluate(id => window.libraryFixture.artworkRepository.appendArtwork({ id }), `right-${round}`),
    ])
    expect(await ids(page)).toEqual([`left-${round}`, `right-${round}`])
  }
})

test('append, favorite, delete, restore and backup merge share the same cross-page boundary', async ({ page, context }) => {
  const other = await context.newPage()
  await Promise.all([enter(page), enter(other)])
  await page.evaluate(() => window.libraryFixture.artworkRepository.appendArtwork({ id: 'original' }))
  await Promise.all([
    page.evaluate(() => window.libraryFixture.artworkRepository.appendArtwork({ id: 'second' })),
    other.evaluate(() => window.libraryFixture.artworkRepository.patchArtwork('original', { favorite: true })),
  ])
  expect(await ids(page)).toEqual(['original', 'second'])
  expect(await page.evaluate(async () => (await window.libraryFixture.kvGet(window.libraryFixture.ARTWORK_HISTORY_KEY))?.find(item => item.id === 'original')?.favorite)).toBe(true)
  await Promise.all([
    page.evaluate(() => window.libraryFixture.artworkRepository.appendArtwork({ id: 'third' })),
    other.evaluate(() => window.libraryFixture.artworkRepository.softDeleteArtwork('original')),
  ])
  expect(await ids(page)).toEqual(['second', 'third'])
  await Promise.all([
    page.evaluate(() => window.libraryFixture.artworkRepository.appendArtwork({ id: 'fourth' })),
    other.evaluate(() => window.libraryFixture.artworkRepository.restoreArtwork('original')),
  ])
  await Promise.all([
    page.evaluate(() => window.libraryFixture.artworkRepository.appendArtwork({ id: 'fifth' })),
    other.evaluate(() => window.libraryFixture.restoreBackupData(window.libraryFixture.normalizeBackup({
      data: { history: [{ id: 'imported' }], projects: [], settings: {} }, images: [],
    }), false)),
  ])
  expect(await ids(page)).toEqual(['fifth', 'fourth', 'imported', 'original', 'second', 'third'])
})

test('a failed transaction releases the cross-page lock and permits a retry', async ({ page, context }) => {
  const other = await context.newPage()
  await Promise.all([enter(page), enter(other)])
  const failed = await page.evaluate(async () => {
    const originalPut = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (..._args) {
      IDBObjectStore.prototype.put = originalPut
      throw new DOMException('fixture quota failure', 'QuotaExceededError')
    }
    try {
      await window.libraryFixture.artworkRepository.appendArtwork({ id: 'retry' })
      return false
    } catch { return true }
    finally { IDBObjectStore.prototype.put = originalPut }
  })
  expect(failed).toBe(true)
  await Promise.all([
    page.evaluate(() => window.libraryFixture.artworkRepository.appendArtwork({ id: 'retry' })),
    other.evaluate(() => window.libraryFixture.artworkRepository.appendArtwork({ id: 'other' })),
  ])
  expect(await ids(page)).toEqual(['other', 'retry'])
})

test('unsupported lock environments refuse writes instead of silently losing data', async ({ page }) => {
  await enter(page)
  const result = await page.evaluate(async () => {
    Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true })
    try {
      await window.libraryFixture.artworkRepository.appendArtwork({ id: 'unsafe' })
      return ''
    } catch (error) { return String(error) }
  })
  expect(result).toContain('跨窗口安全保存')
  expect(await ids(page)).toEqual([])
})


async function seedOrphan(page: Page) {
  await page.evaluate(() => window.libraryFixture.imgPutRecord({
    id: 'cleanup-candidate', blob: new Blob(['image'], { type: 'image/png' }), created_at: 1,
  }))
}

test('orphan cleanup refuses another live document and succeeds after it closes', async ({ page, context }) => {
  const other = await context.newPage()
  await Promise.all([enter(page), enter(other)])
  await Promise.all([
    page.evaluate(() => window.libraryFixture.startArtworkSession()),
    other.evaluate(() => window.libraryFixture.startArtworkSession()),
  ])
  await seedOrphan(page)
  const result = await page.evaluate(async () => {
    const messages: string[] = []
    const count = await window.libraryFixture.useBackup(message => messages.push(message)).cleanOrphanImages()
    return { count, messages }
  })
  expect(result.count).toBe(0)
  expect(result.messages.join(' ')).toContain('未删除图片')
  expect(await page.evaluate(() => window.libraryFixture.imgGetRecord('cleanup-candidate'))).not.toBeNull()
  await other.close()
  await expect.poll(() => page.evaluate(async () => {
    try { return await window.libraryFixture.useBackup(() => {}).cleanOrphanImages() }
    catch { return 0 }
  }), { timeout: 10_000 }).toBe(1)
  expect(await page.evaluate(() => window.libraryFixture.imgGetRecord('cleanup-candidate'))).toBeNull()
})

test('orphan cleanup protects same-document image staging until its reference is published', async ({ page }) => {
  await enter(page)
  await page.evaluate(() => window.libraryFixture.startArtworkSession())
  await seedOrphan(page)
  await page.evaluate(() => {
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    const state: NonNullable<Window['libraryBarrier']> = { entered: false, release, done: Promise.resolve() }
    window.libraryBarrier = state
    state.done = window.libraryFixture.withArtworkStaging(async () => {
      state.entered = true
      await barrier
      await window.libraryFixture.kvSet(window.libraryFixture.ARTWORK_HISTORY_KEY, [{ id: 'saved', image_id: 'cleanup-candidate' }])
    })
  })
  await page.waitForFunction(() => window.libraryBarrier?.entered)
  try {
    expect(await page.evaluate(() => window.libraryFixture.useBackup(() => {}).cleanOrphanImages())).toBe(0)
    expect(await page.evaluate(() => window.libraryFixture.imgGetRecord('cleanup-candidate'))).not.toBeNull()
  } finally {
    await page.evaluate(async () => { window.libraryBarrier!.release(); await window.libraryBarrier!.done })
  }
  expect(await page.evaluate(() => window.libraryFixture.useBackup(() => {}).cleanOrphanImages())).toBe(0)
  expect(await page.evaluate(() => window.libraryFixture.imgGetRecord('cleanup-candidate'))).not.toBeNull()
})

for (const theme of ['dark', 'light']) {
  test(`backup progress can be cancelled without downloading an incomplete file - ${theme}`, async ({ page }) => {
    await enter(page)
    await seedOrphan(page)
    await page.addInitScript(theme => {
      localStorage.setItem('aics_theme', theme)
      // Hold native FileReader at a controllable boundary, not a timed sleep.
      FileReader.prototype.readAsDataURL = function () {
        document.documentElement.dataset.backupReadPending = 'true'
      }
    }, theme)
    await page.goto('/prompt-builder')
    await page.getByLabel(/数据工具/).click()
    let downloads = 0
    page.on('download', () => { downloads++ })
    await page.getByRole('button', { name: '导出备份 JSON', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-backup-read-pending', 'true')
    await expect(page.getByRole('button', { name: '取消备份', exact: true })).toBeVisible()
    const progress = page.getByRole('status').filter({ hasText: '正在备份图片：' })
    await expect(progress).toBeVisible()
    const progressBox = await progress.boundingBox()
    const buttonBox = await page.getByRole('button', { name: '取消备份', exact: true }).boundingBox()
    expect(progressBox).not.toBeNull()
    expect(buttonBox).not.toBeNull()
    expect(progressBox!.width).toBeGreaterThanOrEqual(buttonBox!.width - 1)
    await page.screenshot({ path: test.info().outputPath(`backup-progress-${theme}.png`), fullPage: true })
    await page.getByRole('button', { name: '取消备份', exact: true }).click()
    await expect(page.getByRole('button', { name: '导出备份 JSON', exact: true })).toBeEnabled()
    await expect(page.getByRole('button', { name: '取消备份', exact: true })).toHaveCount(0)
    expect(downloads).toBe(0)
    expect(await page.evaluate(() => localStorage.getItem('aics_backup_last_at'))).toBeNull()
  })
}


test('automatic trash purge uses the same cross-document protection as manual cleanup', async ({ page, context }) => {
  const other = await context.newPage()
  await Promise.all([enter(page), enter(other)])
  await Promise.all([
    page.evaluate(() => window.libraryFixture.startArtworkSession()),
    other.evaluate(() => window.libraryFixture.startArtworkSession()),
  ])
  await seedOrphan(page)
  await page.evaluate(() => window.libraryFixture.kvSet(window.libraryFixture.ARTWORK_TRASH_KEY, [{
    id: 'expired', deletedAt: 1, historyEntries: [{ id: 'expired', image_id: 'cleanup-candidate' }],
    imageIds: ['cleanup-candidate'], projectRefs: [],
  }]))
  const error = await page.evaluate(async () => {
    try { await window.libraryFixture.artworkRepository.purgeExpiredTrash(); return '' }
    catch (error) { return String(error) }
  })
  expect(error).toContain('未删除图片')
  expect(await page.evaluate(() => window.libraryFixture.imgGetRecord('cleanup-candidate'))).not.toBeNull()
  await other.close()
  await expect.poll(() => page.evaluate(async () => {
    try { return await window.libraryFixture.artworkRepository.purgeExpiredTrash() }
    catch { return { purged: 0 } }
  }), { timeout: 10_000 }).toEqual({ purged: 1 })
  expect(await page.evaluate(() => window.libraryFixture.imgGetRecord('cleanup-candidate'))).toBeNull()
})

for (const replacement of ['neutral-new-key', '']) {
  test(`chat credentials do not revive after another window ${replacement ? 'saves' : 'clears'} with real Web Locks`, async ({ context, page }) => {
    const endpoint = 'https://neutral-credential.example/v1'
    let stored: string | null = null
    const writes: string[] = []
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    await context.exposeBinding('credentialReadFixture', async () => stored)
    await context.exposeBinding('credentialWriteFixture', async (_source, _endpoint: string, value: string) => {
      writes.push(value)
      await barrier
      stored = value || null
    })
    await context.addInitScript(() => {
      Object.assign(window, { __TAURI__: {
        core: { invoke: async (command: string, args?: Record<string, unknown>) => {
          if (command === 'chat_credential_read') return window.credentialReadFixture()
          if (command === 'chat_credential_write') return window.credentialWriteFixture(String(args?.endpoint), String(args?.secret ?? ''))
          if (command === 'desktop_bootstrap') return {
            protocolVersion: 1, windowRole: 'atelier', windowId: 'atelier', sourceProfileId: `profile-${'a'.repeat(64)}`,
            sourceOrigin: location.origin, bundledUiAvailable: false, connection: 'ready',
            runtime: { origin: location.origin, protocolVersion: 1, ownership: 'managed', runtimeEpoch: 'credential-fixture', workspace: null },
          }
          if (command === 'window_zoom_get') return 1
          if (command === 'window_zoom_set') return args?.value
          return null
        } },
        event: { listen: async () => () => {} },
        window: { getCurrentWindow: () => ({ startDragging: async () => {} }) },
      } })
    })
    const other = await context.newPage()
    await Promise.all([enter(page), enter(other)])
    try {
      await page.evaluate(({ endpoint, replacement }) => {
        localStorage.setItem('aics_chat_v1', JSON.stringify({ settings: {
          apiBaseUrl: endpoint, apiModel: 'fixture', apiKey: 'neutral-old-key',
        }, histories: {} }))
        const store = window.libraryFixture.useChatStorage()
        window.credentialWork = { store, done: store.setApiSettings({ baseUrl: endpoint, model: 'fixture', apiKey: replacement }) }
      }, { endpoint, replacement })
      await expect.poll(() => writes.length).toBe(1)
      await other.evaluate(() => {
        const store = window.libraryFixture.useChatStorage()
        window.credentialWork = { store, done: store.load() }
      })
      await expect.poll(() => other.evaluate(async () => (await navigator.locks.query()).pending?.some(lock => lock.name?.startsWith('huiyu-chat-credential:')))).toBe(true)
      release()
      await Promise.all([page.evaluate(() => window.credentialWork!.done), other.evaluate(() => window.credentialWork!.done)])
      expect(writes).toEqual([replacement])
      expect(stored || '').toBe(replacement)
      expect(await other.evaluate(() => window.credentialWork!.store.state.settings.apiKey)).toBe(replacement)
      expect(await page.evaluate(() => localStorage.getItem('aics_chat_v1'))).not.toContain('neutral-old-key')
    } finally {
      release()
      await other.close()
    }
  })
}
