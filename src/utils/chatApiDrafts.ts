import { profileLocalStorage as localStorage, flushProfileWrites } from '../platform/web/profileStorage.ts'
import { ref } from 'vue'
import { CHAT_API_PRESETS } from '../config/chatApi.ts'
import { createChatCredentials } from './chatCredentials'

const CHAT_API_DRAFTS_KEY = 'aics_chat_api_drafts'
export interface ChatApiDraft { baseUrl: string; model: string; apiKey: string; keyCleared?: true }
const vendors = new Set<string>(CHAT_API_PRESETS.map(preset => preset.value))
const sessionDrafts: Record<string, ChatApiDraft> = {}
const deferredDrafts = new Map<string, ChatApiDraft>()

function read(): Record<string, ChatApiDraft> {
  const result: Record<string, ChatApiDraft> = {}
  const value = JSON.parse(localStorage.getItem(CHAT_API_DRAFTS_KEY) || '{}')
  for (const [vendor, raw] of Object.entries(value || {})) {
    if (!vendors.has(vendor) || !raw || typeof raw !== 'object') continue
    const entry = raw as Partial<ChatApiDraft>
    if (typeof entry.baseUrl !== 'string' || typeof entry.model !== 'string') continue
    result[vendor] = { baseUrl: entry.baseUrl.slice(0, 500), model: entry.model.slice(0, 200), apiKey: typeof entry.apiKey === 'string' ? entry.apiKey.slice(0, 1000) : '', ...(entry.keyCleared === true ? { keyCleared: true } : {}) }
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

/** Called only after the active credential and configuration were saved successfully. */
export async function rememberSavedChatApiDraft(vendor: string, entry: ChatApiDraft) {
  if (!vendors.has(vendor)) return
  const current = read()
  const metadata = { baseUrl: entry.baseUrl, model: entry.model, ...(!entry.apiKey ? { keyCleared: true as const } : {}) }
  localStorage.setItem(CHAT_API_DRAFTS_KEY, JSON.stringify({ ...current, [vendor]: metadata }))
  sessionDrafts[vendor] = { ...metadata, apiKey: entry.apiKey }
  deferredDrafts.delete(vendor)
  await flushProfileWrites()
}

export function createChatApiDrafts(onError: () => void) {
  const credentials = createChatCredentials()
  let initial: Record<string, ChatApiDraft> = {}
  try { initial = read() } catch { onError() }
  const drafts = ref<Record<string, ChatApiDraft>>({ ...initial })
  const revisions: Record<string, number> = {}
  for (const [vendor, entry] of Object.entries(initial)) {
    const memory = sessionDrafts[vendor]
    if (memory?.baseUrl === entry.baseUrl && !entry.keyCleared) drafts.value[vendor] = { ...memory }
  }
  function persist(vendor: string, entry = drafts.value[vendor]) {
    const current = read()
    const deferred = Boolean(current[vendor]?.apiKey)
    if (deferred) deferredDrafts.set(vendor, entry)
    // Only this provider belongs to the edit; other editors may have saved
    // newer metadata for the remaining providers since this editor opened.
    // Preserve an unmigrated source until its secure write is verified.
    const output = { ...current, [vendor]: current[vendor]?.apiKey
      ? current[vendor] : { baseUrl: entry.baseUrl, model: entry.model, ...(entry.keyCleared ? { keyCleared: true } : {}) } }
    localStorage.setItem(CHAT_API_DRAFTS_KEY, JSON.stringify(output))
    if (!deferred) deferredDrafts.delete(vendor)
  }
  const ready = Promise.all(Object.entries(initial).map(async ([vendor, entry]) => {
    const revision = revisions[vendor] || 0
    try {
      // Only a formally saved desktop credential exists at this exact endpoint.
      // Unsaved provider drafts remain session-only; a clear blocks this fallback.
      const saved = credentials.desktop && !entry.keyCleared ? await credentials.load(entry.baseUrl, '') : ''
      await credentials.load(scope(vendor, entry.baseUrl), entry.apiKey, {
        isCurrent: () => { const current = read()[vendor]; return current?.baseUrl === entry.baseUrl && current?.apiKey === entry.apiKey },
        commit: secret => {
          const current = read()
          if (current[vendor]?.baseUrl === entry.baseUrl && current[vendor]?.apiKey === entry.apiKey) {
            current[vendor].apiKey = ''
            localStorage.setItem(CHAT_API_DRAFTS_KEY, JSON.stringify(current))
            const deferred = deferredDrafts.get(vendor)
            if (deferred) persist(vendor, deferred)
          }
          if ((revisions[vendor] || 0) === revision && !sessionDrafts[vendor]
            && current[vendor]?.baseUrl === entry.baseUrl && !current[vendor]?.keyCleared) {
            drafts.value[vendor] = { ...entry, apiKey: saved || secret }
            sessionDrafts[vendor] = { ...drafts.value[vendor] }
          }
        },
      })
    } catch { onError() }
  })).then(() => {})
  function set(vendor: string, entry: ChatApiDraft) {
    if (!vendors.has(vendor)) return
    revisions[vendor] = (revisions[vendor] || 0) + 1
    const previous = drafts.value[vendor]
    const next = { ...entry }
    if (!entry.apiKey && (entry.keyCleared || previous?.baseUrl === entry.baseUrl && previous.keyCleared)) next.keyCleared = true
    else delete next.keyCleared
    drafts.value[vendor] = next
    sessionDrafts[vendor] = { ...next }
    try { persist(vendor) } catch { onError() }
  }
  async function clear(vendor: string, entry: ChatApiDraft) {
    if (!vendors.has(vendor)) return
    const revision = revisions[vendor] = (revisions[vendor] || 0) + 1
    const sessionEntry = sessionDrafts[vendor]
    const source = read()[vendor]
    await credentials.save(scope(vendor, entry.baseUrl), '', () => {
      const current = read()
      const latest = sessionDrafts[vendor]
      const ownsDraft = revisions[vendor] === revision && latest === sessionEntry
      const sameKey = latest?.baseUrl === entry.baseUrl && latest.apiKey === entry.apiKey
      if (current[vendor]?.baseUrl === entry.baseUrl && current[vendor]?.apiKey === source?.apiKey) {
        current[vendor].apiKey = ''
        if (ownsDraft || sameKey) current[vendor].keyCleared = true
        localStorage.setItem(CHAT_API_DRAFTS_KEY, JSON.stringify(current))
      }
      // The secure deletion owns its original target, not a later edited draft.
      if (ownsDraft) set(vendor, { ...entry, apiKey: '', keyCleared: true })
      else if (sameKey) {
        // Keep newer metadata, but do not resurrect the exact key just removed.
        set(vendor, { ...latest, apiKey: '', keyCleared: true })
      }
    })
    await flushProfileWrites()
  }
  return { drafts, ready, set, clear }
}
