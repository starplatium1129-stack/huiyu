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
    release()
    await drafts.ready
    expect(localStorage.getItem(CHAT_API_DRAFTS_KEY)).not.toContain(secret)
    expect(vault.get(endpoint)).toBe('neutral-active-key')
    expect(vault.get(`${endpoint}#huiyu-api-draft-opencode`)).toBe(secret)
    await drafts.clear('opencode', drafts.drafts.value.opencode)
    expect(drafts.drafts.value.opencode.apiKey).toBe('')
    expect(vault.get(`${endpoint}#huiyu-api-draft-opencode`)).toBe('')
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
