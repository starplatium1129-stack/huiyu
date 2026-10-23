import { CHAT_DRAFT_PREFIX, CHAT_VOLUME_KEY } from '@/utils/storageKeys'
import { getCompanionDefaultOutfit, normalizeCompanionOutfit } from '@/utils/companionRegistry'
import type { ChatPreferences } from '@/storage/chatPreferences'
import type { ChatState } from './chatStorageTypes'

export function createChatPreferenceSetters(state: ChatState, characterIds: string[],
  savePreferences: (patch: Partial<ChatPreferences>) => unknown,
  savePreference: (key: string, value: string) => void) {
  function setActive(char: string) {
    if (!characterIds.includes(char)) return
    state.active = char
    state.settings.live2dOutfit = state.settings.live2dOutfits[state.active] || getCompanionDefaultOutfit(char)
    savePreferences({ active: char })
  }
  function setModel(model: string) { if (state.settings.model === String(model || '')) return; state.settings.model = String(model || ''); savePreferences({ model: state.settings.model }) }
  function setProvider(provider: 'local' | 'api') { state.settings.provider = provider === 'api' ? 'api' : 'local'; savePreferences({ provider: state.settings.provider }) }
  function setWebSearchEnabled(value: boolean) { state.settings.webSearchEnabled = Boolean(value); savePreferences({ webSearchEnabled: state.settings.webSearchEnabled }) }
  function setLive2dEnabled(value: boolean) { state.settings.live2dEnabled = Boolean(value); savePreferences({ live2dEnabled: state.settings.live2dEnabled }) }
  function live2dOutfit(char = state.active) {
    return state.settings.live2dOutfits[char] || getCompanionDefaultOutfit(char)
  }
  function setLive2dOutfit(char: string, value: string) {
    if (!characterIds.includes(char)) return
    const next = normalizeCompanionOutfit(char, value)
    state.settings.live2dOutfits = { ...state.settings.live2dOutfits, [char]: next }
    if (char === state.active) state.settings.live2dOutfit = next
    savePreferences({ live2dOutfits: { [char]: next } })
  }
  function setAutoVoice(v: boolean) { state.settings.autoVoice = Boolean(v); savePreferences({ autoVoice: state.settings.autoVoice }) }
  function setVolume(v: number) {
    state.settings.volume = Math.max(0, Math.min(100, Number.isFinite(Number(v)) ? Math.round(Number(v)) : 80))
    savePreference(CHAT_VOLUME_KEY, String(state.settings.volume))
  }
  function draft(char = state.active) { return state.settings.drafts[char] || '' }
  function setDraft(char: string, val: string) {
    if (!characterIds.includes(char)) return
    state.settings.drafts[char] = String(val || '').slice(0, 1200)
    savePreference(CHAT_DRAFT_PREFIX + char, JSON.stringify(state.settings.drafts[char]))
  }
  return {
    setActive, setModel, setProvider, setWebSearchEnabled, setLive2dEnabled,
    live2dOutfit, setLive2dOutfit, setAutoVoice, setVolume, draft, setDraft,
  }
}
