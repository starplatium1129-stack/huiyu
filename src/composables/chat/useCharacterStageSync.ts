import { computed, ref, type Ref } from 'vue'
import {
  DEFAULT_COMPANION_CHARACTER_ID,
  getCompanionCharacter,
  getCompanionCharacterConfig,
} from '@/utils/companionRegistry'
import { useVoice } from '@/composables/useVoice'
import type { useChatStorage } from '@/composables/chat/useChatStorage'
import type { CharacterPetControls } from '@/composables/chat/useCharacterPetControls'

export interface CharacterStageHandle {
  presentationReady?: import('@/types/desktop').CompanionReadyKind
  petControls?: CharacterPetControls
  playPetMotion?: (id: string) => void
  setPetExpression?: (id: string) => Promise<boolean>
  openSettings?: () => void
  setSpeaking: (value: boolean) => void
  setMouth: (value: number) => void
  setAudioLevel: (level: number, peak?: number) => void
  setEmotion: (emotion: string) => void
  setUserMessage: () => void
  setDesktopVisible?: (visible: boolean) => void
  setDesktopWindowBounds?: (bounds: { x: number; y: number; width: number; height: number }) => void
  setDesktopPerformanceMode?: (onBatteryPower: boolean) => void
  setGlobalPointer?: (screenX: number, screenY: number, bounds: { x: number; y: number; width: number; height: number }) => void
  releasePointerFocus?: () => void
}

export function useCharacterStageSync(options: {
  activeChar: Ref<string>
  storage: ReturnType<typeof useChatStorage>
  setError: (message: string, kind?: string, timeout?: number, code?: string) => void
}) {
  const { activeChar, storage, setError } = options
  const characterStageRef = ref<CharacterStageHandle>()
  const voiceActive = ref(false)
  const voiceStatusText = ref('')
  const playingMid = ref('')
  const isSpeaking = ref(false)
  const autoVoice = ref(storage.state.settings.autoVoice)
  const volume = ref(storage.state.settings.volume != null ? storage.state.settings.volume : 80)

  const voice = useVoice({
    enabled: () => autoVoice.value,
    onStatus: (text) => { voiceStatusText.value = text },
    onError: (message) => setError(message, 'warning'),
    onSpeaking: (speaking, mid) => {
      isSpeaking.value = speaking
      playingMid.value = speaking && mid ? mid : ''
      characterStageRef.value?.setSpeaking(speaking)
    },
    onMouth: (value) => characterStageRef.value?.setMouth(value),
    onAudioLevel: (level, peak) => characterStageRef.value?.setAudioLevel(level, peak),
    onExpression: (emotion) => characterStageRef.value?.setEmotion(emotion),
    onActivity: (active) => { voiceActive.value = active },
  })

  const currentCharacter = computed(() => {
    const config = getCompanionCharacterConfig(activeChar.value)
      || getCompanionCharacterConfig(DEFAULT_COMPANION_CHARACTER_ID)
    if (!config) throw new Error('No companion character presentation is registered')
    const catalogId = getCompanionCharacter(activeChar.value)?.catalogId
    const availability = voice.availability.value
    let resolvedVoice = config.voice
    if (catalogId) {
      const mapped = availability.voiceCatalogMap?.[catalogId]
      if (mapped) {
        resolvedVoice = mapped
      } else if (availability.voices) {
        if (Object.hasOwn(availability.voices, catalogId)) {
          resolvedVoice = catalogId
        } else {
          const prefixMatches = Object.keys(availability.voices).filter(id => catalogId.startsWith(`${id}_`))
          if (prefixMatches.length === 1) resolvedVoice = prefixMatches[0]
        }
      }
    }
    return resolvedVoice === config.voice ? config : { ...config, voice: resolvedVoice }
  })

  function onVolumeChange() {
    voice.setVolume(volume.value / 100)
    storage.setVolume(volume.value)
  }

  return {
    characterStageRef,
    voiceActive,
    voiceStatusText,
    playingMid,
    isSpeaking,
    autoVoice,
    volume,
    voice,
    currentCharacter,
    onVolumeChange,
  }
}
