import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STORAGE_KEY } from '@/config/characters'
import { createBackup } from '@/utils/backupCore'
import { useChatStorage } from './useChatStorage'

const secret = 'neutral-credential-fixture'
const endpoint = 'https://neutral-fixture.example/v1'
const legacy = () => JSON.stringify({ settings: { apiBaseUrl: endpoint, apiModel: 'fixture', apiKey: secret }, histories: {} })
beforeEach(() => {
  let queue = Promise.resolve()
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    request: (_name: string, callback: () => Promise<unknown>) => {
      const next = queue.catch(() => {}).then(callback)
      queue = next.then(() => {}, () => {})
      return next
    },
  } })
})
afterEach(() => { localStorage.clear(); delete window.companionDesktop; Reflect.deleteProperty(navigator, 'locks'); vi.restoreAllMocks() })

function desktop(read: () => Promise<string | null>, write: (endpoint: string, secret: string) => Promise<void>) {
  window.companionDesktop = { isDesktop: true, readChatCredential: read, writeChatCredential: write } as unknown as typeof window.companionDesktop
}

describe('chat credential migration through storage', () => {
  it('keeps new web keys in session memory, persists settings without keys and allows clearing', async () => {
    const storage = useChatStorage()
    await storage.setApiSettings({ baseUrl: endpoint, model: 'fixture', apiKey: secret })
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain(secret)
    const reopened = useChatStorage()
    await reopened.load()
    expect(reopened.state.settings.apiKey).toBe(secret)
    await reopened.setApiSettings({ baseUrl: endpoint, model: 'fixture', apiKey: '' })
    const cleared = useChatStorage()
    await cleared.load()
    expect(cleared.state.settings.apiKey).toBe('')
  })

  it('migrates legacy desktop values only after write and read-back succeed', async () => {
    let resolve!: () => void
    const pending = new Promise<void>(done => { resolve = done })
    let saved: string | null = null
    desktop(async () => saved, async (_, value) => { await pending; saved = value })
    localStorage.setItem(STORAGE_KEY, legacy())
    const storage = useChatStorage()
    const loading = storage.load()
    storage.save()
    expect(localStorage.getItem(STORAGE_KEY)).toContain(secret)
    resolve()
    await loading
    expect(saved).toBe(secret)
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain(secret)
    expect(storage.state.settings.apiKey).toBe(secret)
    const reopened = useChatStorage()
    await reopened.load()
    expect(reopened.state.settings.apiKey).toBe(secret)
  })

  it.each(['write', 'verify'])('preserves usable legacy values on %s failure, without exporting them', async failure => {
    desktop(async () => null, async () => { if (failure === 'write') throw Error('unavailable') })
    localStorage.setItem(STORAGE_KEY, legacy())
    const error = vi.fn()
    const storage = useChatStorage(error)
    await storage.load()
    storage.save()
    expect(storage.state.settings.apiKey).toBe(secret)
    expect(localStorage.getItem(STORAGE_KEY)).toContain(secret)
    expect(error).toHaveBeenCalled()
    const backup = createBackup({ appVersion: 'fixture', settings: { [STORAGE_KEY]: localStorage.getItem(STORAGE_KEY)! } })
    expect(JSON.stringify(backup)).not.toContain(secret)
    // This fixture has no IndexedDB. Async export must reject rather than
    // returning an empty/successful archive or leaking an unobserved rejection.
    await expect(storage.exportArchiveJson()).rejects.toThrow('IndexedDB')
  })

  it('refuses plaintext fallback when an older desktop bridge cannot save securely', async () => {
    window.companionDesktop = { isDesktop: true } as typeof window.companionDesktop
    const storage = useChatStorage()
    await expect(storage.setApiSettings({ baseUrl: endpoint, model: 'fixture', apiKey: secret })).rejects.toThrow()
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('never migrates generated defaults over an existing secure credential', async () => {
    const write = vi.fn(async () => {})
    desktop(async () => secret, write)
    const storage = useChatStorage()
    await storage.load()
    expect(write).not.toHaveBeenCalled()
    expect(storage.state.settings.apiKey).toBe(secret)
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('does not resurrect a key scrubbed by another window while migration is blocked', async () => {
    let release!: () => void
    desktop(async () => secret, async () => new Promise<void>(done => { release = done }))
    localStorage.setItem(STORAGE_KEY, legacy())
    const storage = useChatStorage()
    const loading = storage.load()
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const current = JSON.parse(localStorage.getItem(STORAGE_KEY)!)
    current.settings.apiKey = ''
    current.histories.nene = [{ mid: 'other-window', role: 'user', content: 'new message' }]
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current))
    storage.save()
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain(secret)
    release()
    await loading
    expect(localStorage.getItem(STORAGE_KEY)).toContain('other-window')
  })

  it.each(['new-credential', ''])('does not migrate stale browser data over a concurrent save/clear (%s)', async replacement => {
    let release!: () => void
    let saved: string | null = null
    const writes: string[] = []
    desktop(async () => saved, async (_, value) => {
      writes.push(value)
      if (value === replacement) await new Promise<void>(done => { release = done })
      saved = value || null
    })
    localStorage.setItem(STORAGE_KEY, legacy())
    const editor = useChatStorage()
    const saving = editor.setApiSettings({ baseUrl: endpoint, model: 'fixture', apiKey: replacement })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const stale = useChatStorage()
    const loading = stale.load()
    release()
    await Promise.all([saving, loading])
    expect(writes).toEqual([replacement])
    expect(saved || '').toBe(replacement)
    expect(stale.state.settings.apiKey).toBe(replacement)
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain(secret)
  })

  it('keeps another window migration source when saving ordinary chat changes', async () => {
    const storage = useChatStorage()
    localStorage.setItem(STORAGE_KEY, legacy())
    storage.save()
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).settings.apiKey).toBe(secret)
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).settings.apiBaseUrl).toBe(endpoint)
  })

  it('preserves default/host priority on reload and distinguishes a user key at the default endpoint', async () => {
    let saved: string | null = null
    const write = vi.fn(async (_endpoint: string, value: string) => { saved = value || null })
    desktop(async () => saved, write)
    const first = useChatStorage()
    await first.load()
    const fallbackKey = first.state.settings.apiKey
    first.save()
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).settings.apiConfiguredByUser).toBe(false)
    const reopened = useChatStorage()
    await reopened.load()
    expect(reopened.neverConfigured.value).toBe(true)
    expect(reopened.state.settings.apiKey).toBe(fallbackKey)
    expect(write).not.toHaveBeenCalled()
    await reopened.setApiSettings({ baseUrl: first.state.settings.apiBaseUrl, model: first.state.settings.apiModel, apiKey: secret })
    const configured = useChatStorage()
    await configured.load()
    expect(configured.neverConfigured.value).toBe(false)
    expect(configured.state.settings.apiKey).toBe(secret)
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain(secret)
  })
})
