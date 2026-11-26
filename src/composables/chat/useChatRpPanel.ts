import { computed, reactive, ref } from 'vue'
import { confirmAction } from '@/composables/useConfirm'
import { downloadBlob } from '@/utils/downloadBlob'
import {
  CONTEXT_BUDGET_TIERS,
  exportChatRpPresetJson,
  importChatRpPresetJson,
  validateChatRegexRule,
  type ChatAuthorNote,
  type ChatRpPreset,
  type ChatSamplingSettings,
} from '@/utils/chatRpSettings'
import type { useChatRpSettings } from '@/composables/chat/useChatRpSettings'
import type { useCompanionAffection } from '@/composables/useCompanionAffection'
import type { useChatSceneState } from '@/composables/chat/useChatSceneState'
import type { useChatRoomBackground } from '@/composables/chat/useChatRoomBackground'

export interface ChatRpPanelProps {
  rp: ReturnType<typeof useChatRpSettings>
  characterId: string
  characterName: string
  provider: string
  affection?: ReturnType<typeof useCompanionAffection>
  sceneState?: ReturnType<typeof useChatSceneState>
  roomBackground?: ReturnType<typeof useChatRoomBackground>
}

export interface ChatRpPanelEmit {
  (e: 'close'): void
  (e: 'notice', message: string, kind?: 'info' | 'warning' | 'error'): void
}

/** Owns RP preset editing, author note, context budget, sampling, and regex rule forms. */
export function useChatRpPanel(props: ChatRpPanelProps, emit: ChatRpPanelEmit) {
  const rpState = computed(() => props.rp.rpState.value)
  const allPresets = computed(() => props.rp.allPresets.value)
  const activePreset = computed(() => props.rp.activePreset.value)
  const noteDraft = computed(() => props.rp.getAuthorNote(props.characterId))
  const affectionScore = computed(() => Math.round(props.affection?.getScore(props.characterId) ?? 0))
  const affectionLevel = computed(() => props.affection?.getLevelInfo(props.characterId) ?? null)
  const currentScene = computed(() => props.sceneState?.getSceneState(props.characterId) ?? { location: '', outfit: '', mood: '', updatedAt: 0 })

  function onAffectionRange(event: Event) {
    if (!props.affection) return
    const target = Number((event.target as HTMLInputElement).value)
    if (!Number.isFinite(target)) return
    const current = props.affection.getScore(props.characterId)
    props.affection.addScore(props.characterId, Math.round(target - current))
  }

  function onSceneField(field: 'location' | 'outfit', event: Event) {
    props.sceneState?.updateSceneState(props.characterId, { [field]: (event.target as HTMLInputElement).value })
  }

  const presetFile = ref<HTMLInputElement>()
  const presetEditorOpen = ref(false)
  const presetDraft = reactive({
    id: '',
    name: '',
    description: '',
    systemPrefix: '',
    postHistory: '',
    disableBubbleSplit: false,
  })

  function startNewPreset() {
    presetDraft.id = ''
    presetDraft.name = ''
    presetDraft.description = ''
    presetDraft.systemPrefix = ''
    presetDraft.postHistory = ''
    presetDraft.disableBubbleSplit = true
    presetEditorOpen.value = true
  }

  function startEditPreset() {
    const current = activePreset.value
    if (current.builtin) return
    presetDraft.id = current.id
    presetDraft.name = current.name
    presetDraft.description = current.description || ''
    presetDraft.systemPrefix = current.systemPrefix
    presetDraft.postHistory = current.postHistory
    presetDraft.disableBubbleSplit = current.disableBubbleSplit
    presetEditorOpen.value = true
  }

  function savePresetForm() {
    const name = presetDraft.name.trim()
    if (!name) return
    const preset: ChatRpPreset = {
      id: presetDraft.id || `preset-${crypto.randomUUID()}`,
      name,
      ...(presetDraft.description.trim() ? { description: presetDraft.description.trim() } : {}),
      systemPrefix: presetDraft.systemPrefix,
      postHistory: presetDraft.postHistory,
      disableBubbleSplit: presetDraft.disableBubbleSplit,
    }
    props.rp.upsertCustomPreset(preset)
    presetEditorOpen.value = false
    emit('notice', `已保存预设「${name}」。`, 'info')
  }

  async function removeCustomPreset() {
    const current = activePreset.value
    if (current.builtin) return
    const ok = await confirmAction({
      title: `删除预设「${current.name}」？`,
      message: '删除后将自动切换回默认预设。',
      confirmLabel: '删除预设',
      danger: true,
    })
    if (!ok) return
    props.rp.deleteCustomPreset(current.id)
    presetEditorOpen.value = false
    emit('notice', '已删除自定义预设。', 'info')
  }

  function exportCurrentPreset() {
    const current = activePreset.value
    const json = exportChatRpPresetJson(current)
    downloadBlob(new Blob([json], { type: 'application/json;charset=utf-8' }), `huiyu-preset-${current.id}.json`)
    emit('notice', `已导出预设「${current.name}」。`, 'info')
  }

  async function onImportPreset(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    try {
      const text = await file.text()
      const preset = importChatRpPresetJson(text)
      props.rp.upsertCustomPreset(preset)
      emit('notice', `已导入并启用预设「${preset.name}」。`, 'info')
    } catch (error) {
      emit('notice', error instanceof Error ? error.message : '预设导入失败', 'error')
    }
  }

  function updateNote(patch: Partial<ChatAuthorNote>) {
    props.rp.setAuthorNote(props.characterId, { ...noteDraft.value, ...patch })
  }

  function onNoteInput(event: Event) {
    const text = (event.target as HTMLTextAreaElement).value
    updateNote({ text })
  }

  function onDepthChange(event: Event) {
    const raw = Number((event.target as HTMLInputElement).value)
    const depth = Number.isFinite(raw) ? Math.max(0, Math.min(24, Math.round(raw))) : 2
    updateNote({ depth })
  }

  function isTierActive(maxMessages: number, maxChars: number) {
    return rpState.value.contextBudget.maxMessages === maxMessages && rpState.value.contextBudget.maxChars === maxChars
  }

  function onBudgetChange(field: 'maxMessages' | 'maxChars', event: Event) {
    const raw = Number((event.target as HTMLInputElement).value)
    const current = rpState.value.contextBudget
    if (!Number.isFinite(raw)) return
    if (field === 'maxMessages') {
      props.rp.setContextBudget({ ...current, maxMessages: Math.max(8, Math.min(120, Math.round(raw))) })
    } else {
      props.rp.setContextBudget({ ...current, maxChars: Math.max(4000, Math.min(120_000, Math.round(raw))) })
    }
  }

  function onSamplingChange(field: keyof ChatSamplingSettings, event: Event) {
    const rawText = (event.target as HTMLInputElement).value.trim()
    const next = { ...rpState.value.sampling }
    if (!rawText) {
      delete next[field]
      props.rp.setSampling(next)
      return
    }
    const value = Number(rawText)
    if (!Number.isFinite(value)) return
    next[field] = value
    props.rp.setSampling(next)
  }

  const regexDraft = reactive({ name: '', pattern: '', replacement: '', flags: 'g' })
  const regexError = ref('')

  function addRegexRule() {
    const flags = regexDraft.flags.trim() || 'g'
    const err = validateChatRegexRule(regexDraft.pattern, flags)
    if (err) {
      regexError.value = err
      return
    }
    regexError.value = ''
    props.rp.upsertRegexRule({
      id: `rx-${crypto.randomUUID()}`,
      name: regexDraft.name.trim() || '显示规则',
      enabled: true,
      pattern: regexDraft.pattern,
      replacement: regexDraft.replacement,
      flags,
      target: 'display',
    })
    regexDraft.name = ''
    regexDraft.pattern = ''
    regexDraft.replacement = ''
    regexDraft.flags = 'g'
  }

  return {
    CONTEXT_BUDGET_TIERS,
    rpState,
    allPresets,
    activePreset,
    noteDraft,
    affectionScore,
    affectionLevel,
    currentScene,
    onAffectionRange,
    onSceneField,
    presetFile,
    presetEditorOpen,
    presetDraft,
    startNewPreset,
    startEditPreset,
    savePresetForm,
    removeCustomPreset,
    exportCurrentPreset,
    onImportPreset,
    updateNote,
    onNoteInput,
    onDepthChange,
    isTierActive,
    onBudgetChange,
    onSamplingChange,
    regexDraft,
    regexError,
    addRegexRule,
  }
}
