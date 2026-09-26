import { profileLocalStorage as localStorage } from '../platform/web/profileStorage.ts'
import { ref, computed } from 'vue'
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
    const charState = state.value[character]
    if (charState && typeof charState.score === 'number') {
      return Math.max(0, Math.min(100, charState.score))
    }
    return DEFAULT_SCORES[character] ?? 10
  }

  function getLevelInfo(character: string): AffectionLevelInfo {
    return getAffectionLevel(getScore(character))
  }

  function addScore(character: string, delta: number, _reason?: string): { oldScore: number; newScore: number; levelUp: boolean } {
    try { state.value = loadInitialState(true) } catch {
      const score = getScore(character)
      return { oldScore: score, newScore: score, levelUp: false }
    }
    const current = getScore(character)
    if (!Number.isFinite(delta)) return { oldScore: current, newScore: current, levelUp: false }
    const previous = state.value
    const next = Math.max(0, Math.min(100, current + delta))
    const oldLevel = getAffectionLevel(current).level
    const newLevel = getAffectionLevel(next).level

    state.value = {
      ...state.value,
      [character]: {
        score: next,
        lastInteractedAt: Date.now(),
      },
    }
    if (!saveState()) {
      state.value = previous
      return { oldScore: current, newScore: current, levelUp: false }
    }

    return {
      oldScore: current,
      newScore: next,
      levelUp: newLevel > oldLevel,
    }
  }

  function setScore(character: string, score: number) {
    if (!Number.isFinite(score)) return
    try { state.value = loadInitialState(true) } catch { return }
    const previous = state.value
    const valid = Math.max(0, Math.min(100, Math.round(score)))
    state.value = {
      ...state.value,
      [character]: {
        score: valid,
        lastInteractedAt: Date.now(),
      },
    }
    if (!saveState()) state.value = previous
  }

  function resetScore(character: string) {
    const defaultScore = DEFAULT_SCORES[character] ?? 10
    setScore(character, defaultScore)
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
      const change = addScore(character, picked.entry.bonus, `互动动作 ${picked.entry.name}`)
      bonusAwarded = change.newScore - change.oldScore
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
    addScore,
    setScore,
    resetScore,
    dispatchInteractiveMotion,
    allScores: computed(() => state.value),
  }
}
