import { profileLocalStorage as localStorage } from '../platform/web/profileStorage.ts'
import { ref } from 'vue'
import {
  COMPANION_AFFECTION_KEY,
} from '@/utils/storageKeys'
import {
  getAffectionLevel,
  pickAffectionMotion,
  type AffectionLevelInfo,
  type AffectionMotionEntry,
} from '@/utils/companionAffection'

export interface CharacterAffectionState {
  score: number
  lastInteractedAt?: number
}

export type AffectionStoreState = Record<string, CharacterAffectionState>

const DEFAULT_SCORES: Record<string, number> = {
  natsume: 15,
  nene: 25,
}

const state = ref<AffectionStoreState>(loadInitialState())

function loadInitialState(strict = false): AffectionStoreState {
  if (typeof globalThis.localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(COMPANION_AFFECTION_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return Object.fromEntries(Object.entries(parsed).flatMap(([key, entry]) => {
        const item = entry as Partial<CharacterAffectionState> | null
        return item && typeof item.score === 'number' && Number.isFinite(item.score)
          ? [[key, { score: Math.max(0, Math.min(100, item.score)), lastInteractedAt: Number(item.lastInteractedAt) || undefined }]] : []
      }))
    }
    if (strict) throw new Error('好感度存储格式无效')
  } catch (err) {
    if (strict) throw err
    console.warn('[useCompanionAffection] Failed to load affection state:', err)
  }
  return {}
}

function saveState() {
  if (typeof globalThis.localStorage === 'undefined') return false
  try {
    localStorage.setItem(COMPANION_AFFECTION_KEY, JSON.stringify(state.value))
    return true
  } catch (err) {
    console.warn('[useCompanionAffection] Failed to save affection state:', err)
    return false
  }
}

if (typeof window !== 'undefined') window.addEventListener('storage', event => {
  if (event.key === null || event.key === COMPANION_AFFECTION_KEY) state.value = loadInitialState()
})

export function useCompanionAffection() {
  function getScore(character: string): number {
    return state.value[character]?.score ?? DEFAULT_SCORES[character] ?? 10
  }

  function getLevelInfo(character: string): AffectionLevelInfo {
    return getAffectionLevel(getScore(character))
  }

  function addScore(character: string, delta: number): number {
    try { state.value = loadInitialState(true) } catch { return 0 }
    const current = getScore(character)
    if (!Number.isFinite(delta)) return 0
    const previous = state.value
    const next = Math.max(0, Math.min(100, current + delta))

    state.value = {
      ...state.value,
      [character]: {
        score: next,
        lastInteractedAt: Date.now(),
      },
    }
    if (!saveState()) {
      state.value = previous
      return 0
    }

    return next - current
  }

  /**
   * 针对点击互动挑选合适的动作并应用好感度加成
   */
  function dispatchInteractiveMotion(character: string, group: string): {
    index: number
    entry?: AffectionMotionEntry
    bonusAwarded?: number
  } | null {
    const currentScore = getScore(character)
    const picked = pickAffectionMotion(character, group, currentScore)

    if (!picked) {
      return null
    }

    let bonusAwarded: number | undefined
    if (picked.entry.bonus && picked.entry.bonus > 0) {
      bonusAwarded = addScore(character, picked.entry.bonus)
    }

    return {
      index: picked.index,
      entry: picked.entry,
      bonusAwarded,
    }
  }

  return {
    getScore,
    getLevelInfo,
    dispatchInteractiveMotion,
  }
}
