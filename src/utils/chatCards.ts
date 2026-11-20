import { runtimeFetch, runtimeResourceIdentity } from '@/platform/runtimeUrl'
import { characterArtEntry } from '@/platform/characterArtState'
import { isLocalStudioHost } from './runtimeEnvironment'
import { forgetChatCard, listCompanionCharacterIds, registerCompanionCharacter } from './companionRegistry'

interface ChatCard {
  id: string
  name: string
  description: string
  greeting: string
  avatarUrl: string
  catalogId?: string
}
interface CatalogProfile { image?: string; source?: string; aliases: string[] }
let profiles: Promise<Map<string, CatalogProfile>> | undefined
async function directoryRows(file: string) {
  const response = await runtimeFetch(`/data/${file}`, { signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error('角色目录暂不可用')
  const rows = await response.json()
  if (!Array.isArray(rows)) throw new Error('角色目录格式错误')
  return rows
}
const names = (value: unknown): string[] => Array.isArray(value) ? value.filter((name): name is string => typeof name === 'string') : []
function catalogProfiles() {
  if (profiles) return profiles
  const current = Promise.allSettled([directoryRows('characters.json'), directoryRows('popular-directory.json')]).then(([portraits, works]) => {
    const result = new Map<string, CatalogProfile>()
    for (const entry of portraits.status === 'fulfilled' ? portraits.value : []) {
      if (typeof entry?.id !== 'string') continue
      const path = entry?.portrait?.image
      const image = typeof path === 'string' && /^(?:\.\.\/|\/)?assets\/characters\/[\w/-]+\.(?:png|webp)(?:\?v=[\w-]+)?$/.test(path)
        ? path.replace(/^(?:\.\.\/|\/)?/, '/') : undefined
      result.set(entry.id, { image, source: typeof entry.source === 'string' ? entry.source : undefined,
        aliases: names(entry.alias) })
    }
    // A profile may credit a publisher or a crossover. Browse by the project's work instead.
    for (const entry of works.status === 'fulfilled' ? works.value : []) {
      if (typeof entry?.id !== 'string') continue
      const profile = result.get(entry.id)
      result.set(entry.id, { image: profile?.image,
        source: typeof entry.franchise === 'string' && entry.franchise.trim() ? entry.franchise : profile?.source,
        aliases: [...new Set([...(profile?.aliases || []), ...names(entry.aliases), ...names([entry.originalName])])] })
    }
    if ((portraits.status === 'rejected' || works.status === 'rejected') && profiles === current) profiles = undefined
    return result
  })
  return profiles = current
}

async function registerCard(card: ChatCard, owner: string) {
  if (!card || !/^card-[a-f0-9]{64}$/.test(card.id) || typeof card.name !== 'string' || !card.name.trim()
    || typeof card.greeting !== 'string' || typeof card.description !== 'string'
    || (card.avatarUrl !== '' && card.avatarUrl !== `/api/chat/cards/${card.id}/avatar`)) throw new Error('角色卡目录格式错误')
  const catalogId = typeof card.catalogId === 'string' && /^[a-z0-9_-]{1,80}$/.test(card.catalogId) ? card.catalogId : undefined
  const profile = catalogId ? (await catalogProfiles()).get(catalogId) : undefined
  const image = card.avatarUrl || (catalogId && characterArtEntry(catalogId)?.portraitUrl) || profile?.image || '/assets/logo.svg'
  if (owner !== runtimeResourceIdentity()) throw new Error('工作区已切换，请重新打开角色卡')
  registerCompanionCharacter({
    id: card.id, name: card.name, shortName: card.name, defaultAvatarId: '', tags: ['chat-card'], catalogId,
    source: profile?.source, aliases: profile?.aliases,
    presentation: {
      id: card.id, name: card.name, image, voice: '', icon: 'character', caption: '', description: card.description,
      greeting: card.greeting, roomCode: '', roomMood: '', starters: [], accent: 'var(--accent)',
      live2dLayout: { scale: 1, anchorX: 0.5, bottomOffset: 0 },
    },
  })
  return card.id
}

let pending: Promise<void> | undefined
let directoryOwner = ''
let listening = false
const changeKey = 'huiyu_chat_card_import'
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
    const ids = new Set(await Promise.all(cards.map(card => registerCard(card, owner))))
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
  return registerCard(result.card, owner)
}

export function announceChatCardsChanged() {
  try { localStorage.setItem(changeKey, String(Date.now())) } catch { /* Next room load reads the directory. */ }
}
