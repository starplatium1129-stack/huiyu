import { profileLocalStorage as localStorage } from '../platform/web/profileStorage.ts'
import { ref } from 'vue'
import { createChatCredentials } from './chatCredentials'

export const CHAT_API_DRAFTS_KEY = 'aics_chat_api_drafts'
export interface ChatApiDraft { baseUrl: string; model: string; apiKey: string }
const vendors = new Set(['cliproxy', 'deepseek', 'opencode', 'opencode-go', 'custom'])
const sessionDrafts: Record<string, ChatApiDraft> = {}

function read(): Record<string, ChatApiDraft> {
  const result: Record<string, ChatApiDraft> = {}
  const value = JSON.parse(localStorage.getItem(CHAT_API_DRAFTS_KEY) || '{}')
  for (const [vendor, raw] of Object.entries(value || {})) {
    if (!vendors.has(vendor) || !raw || typeof raw !== 'object') continue
    const entry = raw as Partial<ChatApiDraft>
    if (typeof entry.baseUrl !== 'string' || typeof entry.model !== 'string') continue
    result[vendor] = { baseUrl: entry.baseUrl.slice(0, 500), model: entry.model.slice(0, 200), apiKey: typeof entry.apiKey === 'string' ? entry.apiKey.slice(0, 1000) : '' }
  }
  return result
}

// A fragment is only an opaque credential target; it is never sent to an API.
// Keeping legacy drafts separate prevents overwriting the active personal key.
function scope(vendor: string, endpoint: string) {
  const url = new URL(endpoint)
  url.hash = `huiyu-api-draft-${vendor}`
  return url.href
}

export function createChatApiDrafts(onError: () => void) {
  const credentials = createChatCredentials()
  let initial: Record<string, ChatApiDraft> = {}
  try { initial = read() } catch { onError() }
  const drafts = ref<Record<string, ChatApiDraft>>({ ...initial })
  const revisions: Record<string, number> = {}
  for (const [vendor, entry] of Object.entries(initial)) {
    const memory = sessionDrafts[vendor]
    if (memory?.baseUrl === entry.baseUrl) drafts.value[vendor] = { ...memory }
  }
  function persist() {
    const current = read()
    const output: Record<string, Partial<ChatApiDraft>> = { ...current }
    for (const [vendor, entry] of Object.entries(drafts.value)) {
      // Preserve an unmigrated source, including its endpoint, until verification.
      output[vendor] = current[vendor]?.apiKey ? current[vendor] : { baseUrl: entry.baseUrl, model: entry.model }
    }
    localStorage.setItem(CHAT_API_DRAFTS_KEY, JSON.stringify(output))
  }
  const ready = Promise.all(Object.entries(initial).map(async ([vendor, entry]) => {
    const revision = revisions[vendor] || 0
    try {
      await credentials.load(scope(vendor, entry.baseUrl), entry.apiKey, {
        isCurrent: () => { const current = read()[vendor]; return current?.baseUrl === entry.baseUrl && current?.apiKey === entry.apiKey },
        commit: secret => {
          const current = read()
          if (current[vendor]?.baseUrl === entry.baseUrl && current[vendor]?.apiKey === entry.apiKey) {
            current[vendor].apiKey = ''
            localStorage.setItem(CHAT_API_DRAFTS_KEY, JSON.stringify(current))
          }
          if ((revisions[vendor] || 0) === revision && !sessionDrafts[vendor]) {
            drafts.value[vendor] = { ...entry, apiKey: secret }
            sessionDrafts[vendor] = { ...drafts.value[vendor] }
          }
          persist()
        },
      })
    } catch { onError() }
  })).then(() => {})
  function set(vendor: string, entry: ChatApiDraft) {
    if (!vendors.has(vendor)) return
    revisions[vendor] = (revisions[vendor] || 0) + 1
    drafts.value[vendor] = { ...entry }
    sessionDrafts[vendor] = { ...entry }
    try { persist() } catch { onError() }
  }
  async function clear(vendor: string, entry: ChatApiDraft) {
    await credentials.save(scope(vendor, entry.baseUrl), '', () => {
      const current = read()
      if (current[vendor]?.baseUrl === entry.baseUrl) current[vendor].apiKey = ''
      localStorage.setItem(CHAT_API_DRAFTS_KEY, JSON.stringify(current))
      set(vendor, { ...entry, apiKey: '' })
    })
  }
  return { drafts, ready, set, clear }
}
