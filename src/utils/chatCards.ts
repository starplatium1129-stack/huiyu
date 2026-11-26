import { runtimeFetch, runtimeResourceIdentity } from '@/platform/runtimeUrl'
import { characterArtEntry } from '@/platform/characterArtState'
import { isLocalStudioHost } from './runtimeEnvironment'
import { forgetChatCard, listCompanionCharacterIds, registerCompanionCharacter } from './companionRegistry'
import { loadChatCharacterProfiles } from './chatCharacterProfiles'

export interface ChatCard {
  id: string
  name: string
  description: string
  greeting: string
  greetings?: string[]
  alternateGreetings?: string[]
  avatarUrl: string
  catalogId?: string
  voiceId?: string
  source?: 'user' | 'catalog'
  overridden?: boolean
  loreCount?: number
}
interface CatalogProfile { image?: string; source?: string; aliases: string[] }
let profiles: Promise<Map<string, CatalogProfile>> | undefined
let profilesOwner: string | undefined
async function directoryRows(file: string) {
  const response = await runtimeFetch(`/data/${file}`, { signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error('角色目录暂不可用')
  const rows = await response.json()
  if (!Array.isArray(rows)) throw new Error('角色目录格式错误')
  return rows
}
const names = (value: unknown): string[] => Array.isArray(value) ? value.filter((name): name is string => typeof name === 'string') : []
function catalogProfiles() {
  const owner = runtimeResourceIdentity()
  if (profilesOwner !== owner) {
    profilesOwner = owner
    profiles = undefined
  }
  if (profiles) return profiles
  const current = directoryRows('character-chat-directory.json').catch(() => loadChatCharacterProfiles()).then(async portraits => {
    const result = new Map<string, CatalogProfile>()
    for (const entry of portraits) {
      if (typeof entry?.id !== 'string') continue
      const path = (entry.portrait as { image?: unknown } | null)?.image
      const image = typeof path === 'string' && /^(?:\.\.\/|\/)?assets\/characters\/[\w/-]+\.(?:png|webp)(?:\?v=[\w-]+)?$/.test(path)
        ? path.replace(/^(?:\.\.\/|\/)?/, '/') : undefined
      result.set(entry.id, { image,
        source: typeof entry.franchise === 'string' && entry.franchise.trim() ? entry.franchise : typeof entry.source === 'string' ? entry.source : undefined,
        aliases: [...new Set([...names(entry.alias), ...names(entry.aliases), ...names([entry.originalName])])] })
    }
    // Earlier gateways publish work names separately from full profiles.
    const legacy = portraits.length > 0 && !Object.hasOwn(portraits[0], 'franchise')
    const works = legacy ? await directoryRows('popular-directory.json').catch(() => []) : []
    for (const entry of works) {
      if (typeof entry?.id !== 'string') continue
      const profile = result.get(entry.id)
      result.set(entry.id, { image: profile?.image,
        source: typeof entry.franchise === 'string' && entry.franchise.trim() ? entry.franchise : profile?.source,
        aliases: [...new Set([...(profile?.aliases || []), ...names(entry.aliases), ...names([entry.originalName])])] })
    }
    return result
  }).catch(() => {
    if (profiles === current) profiles = undefined
    return new Map<string, CatalogProfile>()
  })
  return profiles = current
}

function registerCard(card: ChatCard, owner: string, profiles?: ReadonlyMap<string, CatalogProfile>) {
  if (!card || !/^card-[a-f0-9]{64}$/.test(card.id) || typeof card.name !== 'string' || !card.name.trim()
    || typeof card.greeting !== 'string' || typeof card.description !== 'string'
    || (card.avatarUrl !== '' && card.avatarUrl !== `/api/chat/cards/${card.id}/avatar`)) throw new Error('角色卡目录格式错误')
  const catalogId = typeof card.catalogId === 'string' && /^[a-z0-9_-]{1,80}$/.test(card.catalogId) ? card.catalogId : undefined
  const customVoiceId = typeof card.voiceId === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(card.voiceId) ? card.voiceId : ''
  const voice = customVoiceId || (catalogId === 'roxy_migurdia' ? 'roxy' : '')
  const profile = catalogId ? profiles?.get(catalogId) : undefined
  const image = card.avatarUrl || (catalogId && characterArtEntry(catalogId)?.portraitUrl) || profile?.image || '/assets/logo.svg'
  if (owner !== runtimeResourceIdentity()) throw new Error('工作区已切换，请重新打开角色卡')
  const rawGreetings = [
    ...(Array.isArray(card.greetings) ? card.greetings : []),
    card.greeting,
    ...(Array.isArray(card.alternateGreetings) ? card.alternateGreetings : []),
  ]
  const greetings = [...new Set(rawGreetings.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())))]
  const primaryGreeting = greetings[0] || card.greeting
  registerCompanionCharacter({
    id: card.id, name: card.name, shortName: card.name, defaultAvatarId: '', tags: ['chat-card'], catalogId,
    source: profile?.source, aliases: profile?.aliases, voiceId: voice || undefined,
    presentation: {
      id: card.id, name: card.name, image, voice, icon: 'character', caption: '', description: card.description,
      greeting: primaryGreeting, ...(greetings.length > 1 ? { greetings } : {}),
      roomCode: '', roomMood: '', starters: [], accent: 'var(--accent)',
      live2dLayout: { scale: 1, anchorX: 0.5, bottomOffset: 0 },
    },
  })
  return card.id
}

let pending: Promise<void> | undefined
let directoryOwner = ''
let listening = false
const changeKey = 'huiyu_chat_card_import'
const changeEvent = 'huiyu:chat-cards-changed'
export async function loadChatCard(id: string): Promise<void> {
  if (!isLocalStudioHost() || !/^card-[a-f0-9]{64}$/.test(id)) return
  const owner = runtimeResourceIdentity()
  const response = await runtimeFetch(`/api/chat/cards?id=${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error('未能读取当前角色卡')
  const { cards } = await response.json()
  const card = Array.isArray(cards) && cards.find(card => card?.id === id)
  if (card) registerCard(card, owner, card.catalogId && !card.avatarUrl ? await catalogProfiles() : undefined)
}
export function loadChatCards(): Promise<void> {
  const owner = runtimeResourceIdentity()
  if (directoryOwner !== owner) {
    directoryOwner = owner
    pending = undefined
    profiles = undefined
    listCompanionCharacterIds().forEach(forgetChatCard)
  }
  if (!isLocalStudioHost()) return Promise.resolve()
  if (!listening) {
    listening = true
    window.addEventListener('storage', event => {
      if (event.key === changeKey) void Promise.resolve(pending).catch(() => {}).then(loadChatCards).catch(() => {})
    })
  }
  if (pending) return pending
  const previous = listCompanionCharacterIds().filter(id => id.startsWith('card-'))
  const current = (async () => {
    const response = await runtimeFetch('/api/chat/cards', { signal: AbortSignal.timeout(10000) })
    if (!response.ok) throw new Error(`无法读取本机角色卡，请重试（HTTP ${response.status}）`)
    const { cards } = await response.json()
    if (!Array.isArray(cards)) throw new Error('本机角色卡目录格式错误')
    const directory = cards.some(card => typeof card?.catalogId === 'string') ? await catalogProfiles() : undefined
    const ids = new Set(cards.map(card => registerCard(card, owner, directory)))
    if (owner === runtimeResourceIdentity()) previous.forEach(id => { if (!ids.has(id)) forgetChatCard(id) })
  })().finally(() => { if (pending === current) pending = undefined })
  return pending = current
}

export async function importChatCard(file: File, signal: AbortSignal) {
  const owner = runtimeResourceIdentity()
  const data = new FormData()
  data.append('file', file)
  const response = await runtimeFetch('/api/chat/cards', { method: 'POST', body: data, signal })
  const result = await response.json()
  if (!response.ok) throw new Error(result.message || result.error?.message || (typeof result.error === 'string' && result.error) || `角色卡导入失败（HTTP ${response.status}）`)
  return registerCard(result.card, owner, result.card?.catalogId ? await catalogProfiles() : undefined)
}

export function announceChatCardsChanged() {
  window.dispatchEvent(new Event(changeEvent))
  try { localStorage.setItem(changeKey, String(Date.now())) } catch { /* Next room load reads the directory. */ }
}

export function onChatCardsChanged(callback: () => void, signal: AbortSignal) {
  window.addEventListener(changeEvent, callback, { signal })
  window.addEventListener('storage', event => {
    if (event.key === changeKey) callback()
  }, { signal })
}
