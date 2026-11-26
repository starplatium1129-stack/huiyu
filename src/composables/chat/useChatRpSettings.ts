import { computed, onScopeDispose, ref } from 'vue'
import { CHAT_RP_SETTINGS_KEY } from '@/utils/storageKeys'
import {
  BUILTIN_CHAT_RP_PRESETS,
  loadChatRpState,
  normalizeAuthorNote,
  normalizeChatRpState,
  resolveActiveRpPreset,
  resolveEffectiveSampling,
  saveChatRpState,
  type ChatAuthorNote,
  type ChatContextBudget,
  type ChatRegexRule,
  type ChatRpPreset,
  type ChatRpState,
  type ChatSamplingSettings,
} from '@/utils/chatRpSettings'

export function useChatRpSettings() {
  const rpState = ref<ChatRpState>(loadChatRpState())

  function commit(next: ChatRpState) {
    rpState.value = saveChatRpState(next)
  }

  function onStorage(event: StorageEvent) {
    if (event.key === CHAT_RP_SETTINGS_KEY || event.key === null) {
      rpState.value = loadChatRpState()
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('storage', onStorage)
    onScopeDispose(() => window.removeEventListener('storage', onStorage))
  }

  const allPresets = computed(() => [...BUILTIN_CHAT_RP_PRESETS, ...rpState.value.customPresets])
  const activePreset = computed(() => resolveActiveRpPreset(rpState.value))
  const effectiveSampling = computed(() => resolveEffectiveSampling(rpState.value))

  function selectPreset(id: string) {
    commit({ ...rpState.value, activePresetId: id })
  }

  function upsertCustomPreset(preset: ChatRpPreset) {
    const existing = rpState.value.customPresets.filter(p => p.id !== preset.id)
    commit({
      ...rpState.value,
      activePresetId: preset.id,
      customPresets: [...existing, { ...preset, builtin: false }],
    })
  }

  function deleteCustomPreset(id: string) {
    const customPresets = rpState.value.customPresets.filter(p => p.id !== id)
    const activePresetId = rpState.value.activePresetId === id ? 'default' : rpState.value.activePresetId
    commit({ ...rpState.value, activePresetId, customPresets })
  }

  function setContextBudget(budget: ChatContextBudget) {
    commit({ ...rpState.value, contextBudget: budget })
  }

  function setSampling(sampling: ChatSamplingSettings) {
    commit({ ...rpState.value, sampling })
  }

  function resetSampling() {
    commit({ ...rpState.value, sampling: {} })
  }

  function getAuthorNote(characterId: string): ChatAuthorNote {
    return rpState.value.authorNotes[characterId] || { enabled: false, text: '', depth: 2 }
  }

  function setAuthorNote(characterId: string, note: ChatAuthorNote) {
    const normalized = normalizeAuthorNote(note)
    const authorNotes = { ...rpState.value.authorNotes }
    if (!normalized.text.trim() && !normalized.enabled) {
      delete authorNotes[characterId]
    } else {
      authorNotes[characterId] = normalized
    }
    commit({ ...rpState.value, authorNotes })
  }

  function upsertRegexRule(rule: ChatRegexRule) {
    const others = rpState.value.regexRules.filter(item => item.id !== rule.id)
    commit({ ...rpState.value, regexRules: [...others, rule] })
  }

  function toggleRegexRule(id: string, enabled: boolean) {
    commit({
      ...rpState.value,
      regexRules: rpState.value.regexRules.map(rule => (rule.id === id ? { ...rule, enabled } : rule)),
    })
  }

  function deleteRegexRule(id: string) {
    commit({
      ...rpState.value,
      regexRules: rpState.value.regexRules.filter(rule => rule.id !== id),
    })
  }

  function replaceRpState(next: ChatRpState) {
    commit(normalizeChatRpState(next))
  }

  function setStatusBarEnabled(enabled: boolean) {
    commit({ ...rpState.value, statusBarEnabled: Boolean(enabled) })
  }

  function setAffectionPromptEnabled(enabled: boolean) {
    commit({ ...rpState.value, affectionPromptEnabled: Boolean(enabled) })
  }

  return {
    rpState,
    allPresets,
    activePreset,
    effectiveSampling,
    selectPreset,
    upsertCustomPreset,
    deleteCustomPreset,
    setContextBudget,
    setSampling,
    resetSampling,
    getAuthorNote,
    setAuthorNote,
    upsertRegexRule,
    toggleRegexRule,
    deleteRegexRule,
    replaceRpState,
    setStatusBarEnabled,
    setAffectionPromptEnabled,
  }
}
