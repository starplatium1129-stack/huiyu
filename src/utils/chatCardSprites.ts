import { profileLocalStorage as localStorage } from '../platform/web/profileStorage.ts'
import { parseCompanionChatImage, type CompanionChatImage } from '@/types/companionDrawing'
import { CHAT_CARD_SPRITES_KEY } from './storageKeys.ts'

export type CardSpriteEmotion = 'neutral' | 'happy' | 'gentle' | 'shy' | 'serious' | 'sad'

export interface CardSpriteEmotionMeta {
  id: CardSpriteEmotion
  label: string
  prompt: string
}

export const CARD_SPRITE_EMOTIONS: readonly CardSpriteEmotionMeta[] = [
  {
    id: 'neutral',
    label: '常态',
    prompt: 'upper body portrait, looking at viewer, calm natural expression, soft studio lighting, simple clean pastel background',
  },
  {
    id: 'happy',
    label: '开心',
    prompt: 'upper body portrait, looking at viewer, bright warm smile, sparkling happy eyes, soft lighting, simple clean pastel background',
  },
  {
    id: 'gentle',
    label: '温柔',
    prompt: 'upper body portrait, looking at viewer, gentle affectionate smile, relaxed tender gaze, warm soft lighting, simple clean pastel background',
  },
  {
    id: 'shy',
    label: '害羞',
    prompt: 'upper body portrait, looking at viewer, blushing cheeks, shy flustered expression, slightly averted bashful eyes, soft lighting, simple clean pastel background',
  },
  {
    id: 'serious',
    label: '认真',
    prompt: 'upper body portrait, looking at viewer, serious focused expression, steady determined gaze, clean lighting, simple clean pastel background',
  },
  {
    id: 'sad',
    label: '难过',
    prompt: 'upper body portrait, looking at viewer, melancholic sad expression, glistening eyes, downcast vulnerable mood, soft lighting, simple clean pastel background',
  },
]

export interface CardSpriteRecord {
  appearanceTags: string
  sprites: Partial<Record<CardSpriteEmotion, CompanionChatImage>>
}

export type CardSpritesStore = Record<string, CardSpriteRecord>

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const VALID_EMOTIONS = new Set<string>(CARD_SPRITE_EMOTIONS.map(item => item.id))

export function normalizeCardSpriteRecord(raw: unknown): CardSpriteRecord {
  if (!isRecord(raw)) return { appearanceTags: '', sprites: {} }
  const appearanceTags = typeof raw.appearanceTags === 'string' ? raw.appearanceTags.trim().slice(0, 1200) : ''
  const sprites: Partial<Record<CardSpriteEmotion, CompanionChatImage>> = {}
  if (isRecord(raw.sprites)) {
    for (const [emotion, img] of Object.entries(raw.sprites)) {
      if (!VALID_EMOTIONS.has(emotion)) continue
      const parsed = parseCompanionChatImage(img)
      if (parsed) sprites[emotion as CardSpriteEmotion] = parsed
    }
  }
  return { appearanceTags, sprites }
}

export function loadCardSpritesStore(): CardSpritesStore {
  if (typeof globalThis.localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(CHAT_CARD_SPRITES_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!isRecord(parsed)) return {}
    const store: CardSpritesStore = {}
    for (const [cardId, entry] of Object.entries(parsed)) {
      if (!cardId || cardId.length > 100) continue
      const record = normalizeCardSpriteRecord(entry)
      if (record.appearanceTags || Object.keys(record.sprites).length) {
        store[cardId] = record
      }
    }
    return store
  } catch {
    return {}
  }
}

export function saveCardSpritesStore(store: CardSpritesStore): boolean {
  if (typeof globalThis.localStorage === 'undefined') return false
  try {
    localStorage.setItem(CHAT_CARD_SPRITES_KEY, JSON.stringify(store))
    return true
  } catch {
    return false
  }
}

export function getCardSpriteRecord(cardId: string): CardSpriteRecord {
  return loadCardSpritesStore()[cardId] || { appearanceTags: '', sprites: {} }
}

export function setCardAppearanceTags(cardId: string, appearanceTags: string): CardSpriteRecord {
  const store = loadCardSpritesStore()
  const current = store[cardId] || { appearanceTags: '', sprites: {} }
  const next: CardSpriteRecord = {
    ...current,
    appearanceTags: appearanceTags.trim().slice(0, 1200),
  }
  if (!next.appearanceTags && !Object.keys(next.sprites).length) delete store[cardId]
  else store[cardId] = next
  saveCardSpritesStore(store)
  return next
}

export function saveCardSpriteSlot(cardId: string, emotion: CardSpriteEmotion, image: CompanionChatImage): CardSpriteRecord {
  const store = loadCardSpritesStore()
  const current = store[cardId] || { appearanceTags: '', sprites: {} }
  const next: CardSpriteRecord = {
    ...current,
    sprites: { ...current.sprites, [emotion]: image },
  }
  store[cardId] = next
  saveCardSpritesStore(store)
  return next
}

export function removeCardSpriteSlot(cardId: string, emotion: CardSpriteEmotion): CardSpriteRecord {
  const store = loadCardSpritesStore()
  const current = store[cardId] || { appearanceTags: '', sprites: {} }
  const sprites = { ...current.sprites }
  delete sprites[emotion]
  const next: CardSpriteRecord = { ...current, sprites }
  if (!next.appearanceTags && !Object.keys(next.sprites).length) delete store[cardId]
  else store[cardId] = next
  saveCardSpritesStore(store)
  return next
}

export function clearCardSprites(cardId: string): void {
  const store = loadCardSpritesStore()
  if (!store[cardId]) return
  delete store[cardId]
  saveCardSpritesStore(store)
}

export function cardEmotionLabel(emotion: string): string {
  return CARD_SPRITE_EMOTIONS.find(item => item.id === emotion)?.label || ''
}
