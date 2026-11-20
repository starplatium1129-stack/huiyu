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
let portraits: Promise<Map<string, string>> | undefined
function catalogPortraits() {
  return portraits ??= (async () => {
    const response = await runtimeFetch('/data/characters.json', { signal: AbortSignal.timeout(5000) })
    if (!response.ok) throw new Error('角色立绘目录暂不可用')
    const rows = await response.json()
    const result = new Map<string, string>()
    for (const entry of rows) {
      const path = entry?.portrait?.image
      if (typeof path === 'string' && /^(?:\.\.\/|\/)?assets\/characters\/[\w/-]+\.(?:png|webp)(?:\?v=[\w-]+)?$/.test(path))
        result.set(entry.id, path.replace(/^(?:\.\.\/|\/)?/, '/'))
    }
    return result
  })().catch(() => { portraits = undefined; return new Map<string, string>() })
}

async function registerCard(card: ChatCard, owner: string) {
  if (!card || !/^card-[a-f0-9]{64}$/.test(card.id) || typeof card.name !== 'string' || !card.name.trim()
    || typeof card.greeting !== 'string' || typeof card.description !== 'string'
    || (card.avatarUrl !== '' && card.avatarUrl !== `/api/chat/cards/${card.id}/avatar`)) throw new Error('角色卡目录格式错误')
  const catalogId = typeof card.catalogId === 'string' && /^[a-z0-9_-]{1,80}$/.test(card.catalogId) ? card.catalogId : undefined
  const image = card.avatarUrl || (catalogId && (characterArtEntry(catalogId)?.portraitUrl || (await catalogPortraits()).get(catalogId))) || '/assets/logo.svg'
  if (owner !== runtimeResourceIdentity()) throw new Error('工作区已切换，请重新打开角色卡')
  registerCompanionCharacter({
    id: card.id, name: card.name, shortName: card.name, defaultAvatarId: '', tags: ['chat-card'], catalogId,
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
    portraits = undefined
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
