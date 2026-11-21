import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { controlApi } from '@/api/controlApi'
import { voiceApi } from '@/api/voiceApi'
import { useControlContext } from '@/composables/useControlContext'
import { cancelSystemSpeech, isSystemSpeechSupported, playSystemSpeech } from '@/composables/voiceSpeechSynthesis'
import { getDesktopCapabilities } from '@/platform/desktop/capabilities'
import type { TtsApiPatch, TtsEngine, VoicePackImportResult, VoiceSetupStatus } from '@/types/api'

const ENGINE_LABELS: Record<TtsEngine, string> = {
  off: '已关闭',
  system: '系统朗读',
  'openai-tts': '云端语音接口',
  'gpt-sovits-native': 'GPT-SoVITS 本机',
  'gpt-sovits': 'GPT-SoVITS',
  voxcpm2: 'VoxCPM2',
}

function base64ToBlobUrl(base64: string, contentType: string): string {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return URL.createObjectURL(new Blob([bytes], { type: contentType || 'audio/mpeg' }))
}

export function useVoiceConfigPanel() {
  const { status, actions } = useControlContext()
  const desktop = getDesktopCapabilities()
  const setupStatus = ref<VoiceSetupStatus | null>(null)
  const setupLoading = ref(false)
  const setupError = ref('')
  const notice = ref('')
  const localError = ref('')
  const saving = ref(false)

  const localEngine = ref<'gpt-sovits-native' | 'gpt-sovits' | 'voxcpm2'>('gpt-sovits-native')
  const apiBaseUrl = ref('')
  const apiKey = ref('')
  const showApiKey = ref(false)
  const clearApiKey = ref(false)
  const apiModel = ref('')
  const apiVoiceNene = ref('')
  const apiVoiceNatsume = ref('')
  const apiDefaultVoice = ref('')
  const apiFormat = ref<'mp3' | 'wav' | 'opus' | 'aac'>('mp3')
  const apiTesting = ref(false)
  const testAudioUrl = ref('')

  const packFolderPath = ref('')
  const packTargetChar = ref<'auto' | 'nene' | 'natsume'>('auto')
  const packBusy = ref(false)
  const packPreview = ref<VoicePackImportResult | null>(null)
  const systemPreviewBusy = ref<'nene' | 'natsume' | null>(null)

  const currentEngine = computed<TtsEngine>(() => status.ttsEngine.value)
  const currentEngineLabel = computed(() => ENGINE_LABELS[currentEngine.value] ?? currentEngine.value)
  const activeModeGroup = computed<'system' | 'openai-tts' | 'local' | 'off'>(() => {
    if (currentEngine.value === 'off' || currentEngine.value === 'system' || currentEngine.value === 'openai-tts') {
      return currentEngine.value
    }
    return 'local'
  })
  const hasSavedApiKey = computed(() => Boolean((setupStatus.value?.ttsApi ?? status.ttsApi.value)?.hasApiKey))
  const speechSupported = isSystemSpeechSupported()

  watch(currentEngine, value => {
    if (value === 'gpt-sovits-native' || value === 'gpt-sovits' || value === 'voxcpm2') {
      localEngine.value = value
    }
  }, { immediate: true })

  function syncApiFields(cfg: NonNullable<VoiceSetupStatus['ttsApi']> | null | undefined) {
    if (!cfg) return
    apiBaseUrl.value = cfg.baseUrl || ''
    apiModel.value = cfg.model || ''
    apiVoiceNene.value = cfg.voiceNene || ''
    apiVoiceNatsume.value = cfg.voiceNatsume || ''
    apiDefaultVoice.value = cfg.defaultVoice || ''
    apiFormat.value = cfg.responseFormat || 'mp3'
    apiKey.value = ''
    clearApiKey.value = false
  }

  let initialSynced = false
  watch(() => status.ttsApi.value, cfg => {
    if (!initialSynced && cfg) {
      initialSynced = true
      syncApiFields(cfg)
    }
  }, { immediate: true })

  function revokeTestAudio() {
    if (!testAudioUrl.value) return
    URL.revokeObjectURL(testAudioUrl.value)
    testAudioUrl.value = ''
  }

  async function refreshSetup() {
    setupLoading.value = true
    setupError.value = ''
    try {
      const data = await voiceApi.getSetupStatus()
      setupStatus.value = data
      syncApiFields(data.ttsApi)
      initialSynced = true
    } catch (error) {
      setupError.value = actions.errorMessage(error, '读取语音环境状态失败')
    } finally {
      setupLoading.value = false
    }
  }

  function buildVoicesPayload() {
    return {
      nene: {
        loraWeightsPath: status.voiceNeneLora.value.trim(),
        gptWeightsPath: status.voiceNeneGpt.value.trim(),
        sovitsWeightsPath: status.voiceNeneSovits.value.trim(),
        refAudioPath: status.voiceNeneRef.value.trim(),
        promptText: status.voiceNenePrompt.value.trim(),
        promptLang: 'ja',
        textLang: 'ja',
      },
      natsume: {
        loraWeightsPath: status.voiceNatsumeLora.value.trim(),
        gptWeightsPath: status.voiceNatsumeGpt.value.trim(),
        sovitsWeightsPath: status.voiceNatsumeSovits.value.trim(),
        refAudioPath: status.voiceNatsumeRef.value.trim(),
        promptText: status.voiceNatsumePrompt.value.trim(),
        promptLang: 'ja',
        textLang: 'ja',
      },
    }
  }

  async function applyEngine(engine: TtsEngine, extraApi?: TtsApiPatch) {
    saving.value = true
    notice.value = ''
    localError.value = ''
    try {
      await controlApi.saveConfig({
        sdHost: status.sdHost.value.trim(),
        comfyHost: status.comfyHost.value.trim(),
        ttsHost: status.ttsHost.value.trim(),
        ttsEngine: engine,
        ...(extraApi ? { ttsApi: extraApi } : {}),
        voices: buildVoicesPayload(),
      })
      status.ttsEngine.value = engine
      await Promise.allSettled([status.pollStatus(true), refreshSetup()])
      notice.value = `已切换为「${ENGINE_LABELS[engine]}」并立即生效，无需重启。`
    } catch (error) {
      localError.value = actions.errorMessage(error, '保存语音配置失败')
    } finally {
      saving.value = false
    }
  }

  function previewSystemCharacter(id: 'nene' | 'natsume') {
    notice.value = ''
    localError.value = ''
    if (!speechSupported) {
      localError.value = '当前浏览器或桌面内核不支持系统朗读。'
      return
    }
    systemPreviewBusy.value = id
    const text = id === 'nene'
      ? '你好，我是绫地宁宁。现在的系统朗读已经准备好了。'
      : '你好，我是四季夏目。声音和语速都已经调好，可以直接聊天。'
    const speech = playSystemSpeech({
      text,
      voice: id,
      language: 'zh',
      volume: 1,
    })
    void speech.result.then(reason => {
      if (systemPreviewBusy.value === id) systemPreviewBusy.value = null
      if (reason === 'play-error') localError.value = '系统朗读试听失败，请检查系统语音包。'
    })
  }

  function applyApiPreset(preset: 'siliconflow' | 'openai' | 'custom') {
    localError.value = ''
    if (preset === 'siliconflow') {
      apiBaseUrl.value = 'https://api.siliconflow.cn/v1'
      apiModel.value = 'FunAudioLLM/CosyVoice2-0.5B'
      apiVoiceNene.value = 'FunAudioLLM/CosyVoice2-0.5B:anna'
      apiVoiceNatsume.value = 'FunAudioLLM/CosyVoice2-0.5B:bella'
      apiDefaultVoice.value = 'FunAudioLLM/CosyVoice2-0.5B:anna'
      apiFormat.value = 'mp3'
    } else if (preset === 'openai') {
      apiBaseUrl.value = 'https://api.openai.com/v1'
      apiModel.value = 'gpt-4o-mini-tts'
      apiVoiceNene.value = 'nova'
      apiVoiceNatsume.value = 'shimmer'
      apiDefaultVoice.value = 'alloy'
      apiFormat.value = 'mp3'
    } else {
      apiBaseUrl.value = ''
      apiModel.value = ''
      apiVoiceNene.value = ''
      apiVoiceNatsume.value = ''
      apiDefaultVoice.value = ''
    }
  }

  function collectApiPatch(): TtsApiPatch {
    return {
      baseUrl: apiBaseUrl.value.trim(),
      ...(apiKey.value.trim() ? { apiKey: apiKey.value.trim() } : {}),
      ...(clearApiKey.value ? { clearApiKey: true } : {}),
      model: apiModel.value.trim(),
      voiceNene: apiVoiceNene.value.trim(),
      voiceNatsume: apiVoiceNatsume.value.trim(),
      defaultVoice: apiDefaultVoice.value.trim(),
      responseFormat: apiFormat.value,
    }
  }

  async function saveOpenAiTts() {
    if (!apiBaseUrl.value.trim() || !apiModel.value.trim()) {
      localError.value = '请填写语音接口地址（Base URL）和模型名称。'
      return
    }
    await applyEngine('openai-tts', collectApiPatch())
  }

  async function testOpenAiTts() {
    if (!apiBaseUrl.value.trim() || !apiModel.value.trim()) {
      localError.value = '试听前请先填写接口地址与模型名称。'
      return
    }
    apiTesting.value = true
    localError.value = ''
    notice.value = ''
    try {
      const result = await voiceApi.testApi({
        ...collectApiPatch(),
        voice: apiVoiceNene.value.trim() || apiDefaultVoice.value.trim() || 'alloy',
        text: '你好，这是一段云端语音接口试听，听到这句话说明接口连接正常。',
      })
      revokeTestAudio()
      testAudioUrl.value = base64ToBlobUrl(result.audioBase64, result.contentType)
      notice.value = `试听音频生成成功（${Math.max(1, Math.round(result.bytes / 1024))} KB），请点击下方播放器试听。`
    } catch (error) {
      localError.value = actions.errorMessage(error, '云端语音接口测试失败')
    } finally {
      apiTesting.value = false
    }
  }

  async function pickPackFolder() {
    if (!desktop?.pickWorkspace) return
    try {
      const picked = await desktop.pickWorkspace(packFolderPath.value || setupStatus.value?.workspacePath)
      if (picked) {
        packFolderPath.value = picked
        await scanOrApplyPack(false)
      }
    } catch (error) {
      localError.value = actions.errorMessage(error, '打开文件夹选择器失败')
    }
  }

  async function scanOrApplyPack(apply: boolean) {
    const folderPath = packFolderPath.value.trim()
    if (!folderPath) {
      localError.value = '请先选择或输入语音包所在文件夹路径。'
      return
    }
    packBusy.value = true
    localError.value = ''
    notice.value = ''
    try {
      const result = await voiceApi.importPack({
        folderPath,
        ...(packTargetChar.value !== 'auto' ? { characterId: packTargetChar.value } : {}),
        apply,
      })
      packPreview.value = result
      if (apply) {
        status.ttsEngine.value = localEngine.value
        const existing = buildVoicesPayload()
        await controlApi.saveConfig({
          sdHost: status.sdHost.value.trim(),
          comfyHost: status.comfyHost.value.trim(),
          ttsHost: status.ttsHost.value.trim(),
          ttsEngine: localEngine.value,
          voices: { ...existing, ...result.voices },
        })
        await Promise.allSettled([status.pollStatus(true), refreshSetup()])
        notice.value = `已导入声线并切换到「${ENGINE_LABELS[localEngine.value]}」，无需重启。`
      } else {
        notice.value = `已识别 ${result.detectedFiles.length} 个语音文件，确认后点击「导入并启用」。`
      }
    } catch (error) {
      localError.value = actions.errorMessage(error, apply ? '导入语音包失败' : '扫描语音包失败')
    } finally {
      packBusy.value = false
    }
  }

  onMounted(() => { void refreshSetup() })
  onUnmounted(() => {
    cancelSystemSpeech()
    revokeTestAudio()
  })

  return {
    status, actions, desktop, setupStatus, setupLoading, setupError, notice, localError, saving,
    currentEngine, currentEngineLabel, activeModeGroup, localEngine, speechSupported, systemPreviewBusy,
    apiBaseUrl, apiKey, showApiKey, clearApiKey, apiModel, apiVoiceNene, apiVoiceNatsume, apiDefaultVoice,
    apiFormat, hasSavedApiKey, apiTesting, testAudioUrl,
    packFolderPath, packTargetChar, packBusy, packPreview,
    refreshSetup, applyEngine, previewSystemCharacter, applyApiPreset, saveOpenAiTts, testOpenAiTts,
    pickPackFolder, scanOrApplyPack,
  }
}
