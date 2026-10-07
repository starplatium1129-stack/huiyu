import type { CompanionDesktopBridge } from '@/types/desktop'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createChatApiDrafts, CHAT_API_DRAFTS_KEY } from './chatApiDrafts'
import { createBackup } from './backupCore'

const endpoint = 'https://neutral-drafts.example/v1'
const secret = 'neutral-legacy-draft-key'
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
afterEach(() => { localStorage.clear(); desktopFixture.current = undefined; Reflect.deleteProperty(navigator, 'locks'); vi.restoreAllMocks() })
function seed(vendor: string) {
  localStorage.setItem(CHAT_API_DRAFTS_KEY, JSON.stringify({ [vendor]: { baseUrl: endpoint, model: 'fixture', apiKey: secret } }))
}
function bridge(read: (endpoint: string) => Promise<string | null>, write: (endpoint: string, secret: string) => Promise<void>) {
  desktopFixture.current = { isDesktop: true, readChatCredential: read, writeChatCredential: write } as unknown as (CompanionDesktopBridge | undefined)
}

describe('provider draft credentials', () => {
  it('editing one provider does not revert another provider saved by a newer editor', async () => {
    const older = createChatApiDrafts(vi.fn())
    await older.ready
    older.set('custom', { baseUrl: endpoint, model: 'old', apiKey: '' })
    const newer = createChatApiDrafts(vi.fn())
    await newer.ready
    newer.set('custom', { baseUrl: endpoint, model: 'new', apiKey: '' })
    older.set('deepseek', { baseUrl: 'https://neutral-other.example/v1', model: 'other', apiKey: '' })
    expect(JSON.parse(localStorage.getItem(CHAT_API_DRAFTS_KEY)!).custom.model).toBe('new')
  })

  it('keeps vendor switching keys in memory while persisting only non-secret fields', async () => {
    const drafts = createChatApiDrafts(vi.fn())
    await drafts.ready
    drafts.set('custom', { baseUrl: endpoint, model: 'fixture', apiKey: 'neutral-new-draft-key' })
    drafts.set('deepseek', { baseUrl: 'https://api.deepseek.com', model: 'fixture', apiKey: 'neutral-second-key' })
    expect(drafts.drafts.value.custom.apiKey).toBe('neutral-new-draft-key')
    expect(localStorage.getItem(CHAT_API_DRAFTS_KEY)).not.toContain('neutral-new-draft-key')
    expect(localStorage.getItem(CHAT_API_DRAFTS_KEY)).not.toContain('neutral-second-key')
    const reopened = createChatApiDrafts(vi.fn())
    await reopened.ready
    expect(reopened.drafts.value.custom.apiKey).toBe('neutral-new-draft-key')
  })

  it('verifies a legacy draft in its own secure target before removing plaintext', async () => {
    seed('opencode')
    let release!: () => void
    const pending = new Promise<void>(done => { release = done })
    const vault = new Map([[endpoint, 'neutral-active-key']])
    bridge(async target => vault.get(target) || null, async (target, value) => { await pending; vault.set(target, value) })
    const drafts = createChatApiDrafts(vi.fn())
    expect(localStorage.getItem(CHAT_API_DRAFTS_KEY)).toContain(secret)
    const newer = createChatApiDrafts(vi.fn())
    newer.set('opencode', { baseUrl: endpoint, model: 'newer-model', apiKey: secret })
    release()
    await Promise.all([drafts.ready, newer.ready])
    expect(JSON.parse(localStorage.getItem(CHAT_API_DRAFTS_KEY)!).opencode.model).toBe('newer-model')
    expect(localStorage.getItem(CHAT_API_DRAFTS_KEY)).not.toContain(secret)
    expect(vault.get(endpoint)).toBe('neutral-active-key')
    expect(vault.get(`${endpoint}#huiyu-api-draft-opencode`)).toBe(secret)
    await drafts.clear('opencode', drafts.drafts.value.opencode)
    expect(drafts.drafts.value.opencode.apiKey).toBe('')
    expect(vault.get(`${endpoint}#huiyu-api-draft-opencode`)).toBe('')
  })

  it('preserves newer same-vendor edits in this editor and a reopened editor during clear', async () => {
    const vault = new Map<string, string>()
    let release!: () => void
    let entered!: () => void
    let started = new Promise<void>(resolve => { entered = resolve })
    bridge(async target => vault.get(target) || null, async (target, value) => {
      entered()
      await new Promise<void>(resolve => { release = resolve })
      vault.set(target, value)
    })
    const drafts = createChatApiDrafts(vi.fn())
    await drafts.ready
    const old = { baseUrl: endpoint, model: 'old', apiKey: 'fixture-old' }
    drafts.set('cliproxy', old)
    const clearing = drafts.clear('cliproxy', old)
    await started
    const fresh = { baseUrl: 'https://fresh.example/v1', model: 'fresh', apiKey: 'fixture-new' }
    drafts.set('cliproxy', fresh)
    release(); await clearing
    expect(drafts.drafts.value.cliproxy).toEqual(fresh)
    const reopened = createChatApiDrafts(vi.fn()); await reopened.ready
    expect(reopened.drafts.value.cliproxy).toEqual(fresh)
    started = new Promise<void>(resolve => { entered = resolve })
    const secondClear = drafts.clear('cliproxy', fresh)
    await started
    const newest = { ...fresh, model: 'newest', apiKey: 'fixture-newest' }
    reopened.set('cliproxy', newest)
    release(); await secondClear
    const latest = createChatApiDrafts(vi.fn()); await latest.ready
    expect(latest.drafts.value.cliproxy).toEqual(newest)
    expect(JSON.parse(localStorage.getItem(CHAT_API_DRAFTS_KEY)!).cliproxy.model).toBe('newest')
    expect(localStorage.getItem(CHAT_API_DRAFTS_KEY)).not.toContain('fixture-newest')
    started = new Promise<void>(resolve => { entered = resolve })
    const metadataClear = latest.clear('cliproxy', newest)
    await started
    latest.set('cliproxy', { ...newest, model: 'metadata-edited' })
    release(); await metadataClear
    expect(latest.drafts.value.cliproxy).toEqual({ ...newest, model: 'metadata-edited', apiKey: '' })
  })

  it('preserves failed legacy sources but excludes them from backups', async () => {
    seed('opencode-go')
    bridge(async () => null, async () => { throw Error('credential store unavailable') })
    const error = vi.fn()
    const drafts = createChatApiDrafts(error)
    await drafts.ready
    drafts.set('custom', { baseUrl: endpoint, model: 'new', apiKey: 'neutral-never-persist' })
    expect(error).toHaveBeenCalled()
    expect(localStorage.getItem(CHAT_API_DRAFTS_KEY)).toContain(secret)
    expect(localStorage.getItem(CHAT_API_DRAFTS_KEY)).not.toContain('neutral-never-persist')
    const backup = createBackup({ appVersion: 'fixture', settings: { [CHAT_API_DRAFTS_KEY]: localStorage.getItem(CHAT_API_DRAFTS_KEY)! } })
    expect(JSON.stringify(backup)).not.toContain(secret)
  })
})

const desktopFixture = vi.hoisted(() => ({ current: undefined as CompanionDesktopBridge | undefined }))
vi.mock('@/platform/desktop/capabilities', () => ({ getDesktopCapabilities: () => desktopFixture.current }))
