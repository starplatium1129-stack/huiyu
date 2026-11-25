import { computed, onBeforeUnmount, onMounted, onUnmounted, ref, watch, type Ref } from 'vue'
import type { CharacterStageProps } from '@/types/characterStage'
import { useAnime25DStage } from '@/composables/useAnime25DStage'
import {
  getCompanionDefaultOutfit,
  getCompanionCharacter,
  listCompanionCharacterIds,
  listCompanionOutfits,
  listCompanionUiCharacters,
  normalizeCompanionOutfit,
  resolveCompanionAvatar,
} from '@/utils/companionRegistry'
import { useLive2D } from '@/composables/useLive2D'
import { useMotionPreference } from '@/composables/useMotionPreference'
import { useCharacterPetControls } from '@/composables/chat/useCharacterPetControls'
import { useLive2DPreferences } from '@/composables/live2d/preferences'
import { createEmotionRuntime, getEmotionRuntimeConfig, type EmotionRuntime } from '@/utils/emotionRuntime'
import { profileEmotionConfig } from '@/live2d/companionEmotion'
import type { Live2DBackendKind } from '@/live2d/types'
import type { CompanionReadyKind } from '@/types/desktop'
import { useCompanionInput } from '@/composables/chat/useCompanionInput'

const companionCharacters = listCompanionUiCharacters()
const CHARACTER_IDS = listCompanionCharacterIds()

export interface CharacterStageBridgeDeps {
  props: CharacterStageProps
  stageRef: Ref<HTMLElement | undefined>
  animeHostRef: Ref<HTMLElement | undefined>
  live2dHostRef: Ref<HTMLElement | undefined>
  modelStudioOpen: Ref<boolean>
  wardrobeOpen: Ref<boolean>
  portraitLoaded: Ref<boolean>
  portraitFailed: Ref<boolean>
  framing: Ref<{ zoom: number; x: number; y: number }>
  closeModelStudio: () => void
  closeWardrobe: () => void
  emitLive2dEnabled: (enabled: boolean) => void
  emitOutfitChanged: (outfit: string) => void
}

export function useCharacterStageBridge(deps: CharacterStageBridgeDeps) {
  const { props, stageRef, animeHostRef, live2dHostRef, modelStudioOpen, wardrobeOpen } = deps

  const companionInput = useCompanionInput()
  const anime = useAnime25DStage(() => props.activeId, animeHostRef, companionInput?.captureCanvas)
  watch(() => props.presence, value => anime.setPresence(value || 'available'), { immediate: true })

  const emotion = ref('neutral')
  const avatarText = ref('检测 Live2D…')
  const avatarState = ref('checking')
  const avatarDetail = ref('')
  const avatarRetryable = ref(false)
  const outfitBusy = ref(false)
  const live2dInitialized = ref(false)
  let stageAlive = true
  let characterRequest = 0
  let enableRequest = 0
  const currentCharacterRequest = (id: string, request: number) => stageAlive && props.activeId === id && request === characterRequest

  // 换装选择按角色记忆（宁宁/夏目共用 storage 单字段，值空间分离）
  const outfitByChar = ref<Record<string, string>>({
    ...Object.fromEntries(CHARACTER_IDS.map(id => [id, getCompanionDefaultOutfit(id)])),
  })
  const currentOutfitId = () => outfitByChar.value[props.activeId] ?? props.outfit
  const outfitOptions = computed(() => listCompanionOutfits(props.activeId))
  const activeOutfitLabel = computed(() => {
    const list = outfitOptions.value
    const found = list.find(option => option.id === currentOutfitId())
    return found?.label ?? list[0]?.label ?? '无可用服装'
  })

  const live2d = useLive2D((status) => {
    avatarText.value = status.text
    avatarState.value = status.state
    avatarDetail.value = status.detail
    avatarRetryable.value = status.retryable
  })
  const live2dReady = computed(() => live2d.ready.value && live2d.loadedCharacter.value === props.activeId)
  const reducedMotion = useMotionPreference()
  const stageSuspended = computed(() => props.suspended || modelStudioOpen.value)
  const nativePaused = computed(() => live2d.backendKind.value === 'native' && reducedMotion.value)
  const paintedModel = computed(() => !stageSuspended.value && (anime.active.value || live2dReady.value && !nativePaused.value))

  if (companionInput) watch([paintedModel, live2dReady, live2d.backendKind, () => props.activeId], ([painted, ready, backend], _, cleanup) => {
    if (painted && ready && backend === 'browser') {
      const stop = live2d.onCanvasFrame(companionInput.captureCanvas)
      if (stop) cleanup(stop)
    }
  }, { flush: 'post' })

  const presentationReady = computed<CompanionReadyKind | undefined>(() => {
    if (!live2dInitialized.value || anime.restoring.value) return undefined
    const canRenderNative = live2d.backendKind.value === 'native' &&
      (live2dReady.value || !['static', 'fallback', 'degraded'].includes(avatarState.value))
    if ((props.autoLoad || live2dReady.value) && !stageSuspended.value && !nativePaused.value && !anime.selected.value && canRenderNative) return 'native'
    if (paintedModel.value || deps.portraitLoaded.value) return 'static'
    if (deps.portraitFailed.value) return 'failed'
    return undefined
  })

  watch(anime.selected, value => {
    if (value) { enableRequest++; live2d.disable(true) }
    else if (!anime.restoring.value && live2dInitialized.value && props.autoLoad) void enableCharacter(true)
  }, { flush: 'sync' })
  watch(deps.framing, () => live2d.layout(), { deep: true, flush: 'post' })

  let desktopVisible = true
  function updateStageVisibility() {
    const visible = desktopVisible && !props.suspended && !modelStudioOpen.value
    anime.setVisible(visible)
    live2d.setPaused(!visible)
    if (visible && !anime.selected.value) void live2d.recover()
  }
  watch(modelStudioOpen, updateStageVisibility)
  watch(() => props.suspended, updateStageVisibility, { immediate: true })

  const { quality } = useLive2DPreferences()
  watch([quality, live2d.backendKind], ([value]) => {
    void live2d.setQuality(value)
  }, { immediate: true, flush: 'sync' })
  watch(() => props.volume, value => live2d.setVolume((value ?? 80) / 100), { immediate: true })

  const emotionRuntimes = new Map<string, EmotionRuntime>()
  for (const definition of companionCharacters) {
    const runtimeConfig = getEmotionRuntimeConfig(definition.emotionProfileId || '') || profileEmotionConfig(resolveCompanionAvatar(definition.id)?.profile)
    if (runtimeConfig) emotionRuntimes.set(definition.id, createEmotionRuntime(runtimeConfig))
  }
  function activeRuntime(): EmotionRuntime | null {
    const definition = getCompanionCharacter(props.activeId)
    return definition ? emotionRuntimes.get(definition.id) || null : null
  }

  const avatarActionable = computed(() =>
    avatarState.value !== 'checking'
      && avatarState.value !== 'loading'
      && (!live2d.enabled.value || live2d.ready.value || avatarRetryable.value),
  )

  const avatarActionTitle = computed(() => {
    if (avatarState.value === 'loading') return '正在加载 Live2D 动态模型'
    if (!live2d.enabled.value) return '按需下载并启用 Live2D 动态模型'
    if (live2d.ready.value) return '切换回静态立绘并释放 Live2D 资源'
    return avatarDetail.value
  })

  async function handleAvatarAction() {
    if (!live2d.enabled.value) {
      if (await enableCharacter()) deps.emitLive2dEnabled(true)
      return
    }
    if (live2d.ready.value) {
      deps.emitLive2dEnabled(false)
      live2d.disable()
      return
    }
    if (avatarRetryable.value) await live2d.retry()
  }

  async function enableCharacter(automatic = false) {
    const id = props.activeId
    const request = ++enableRequest
    const current = () => stageAlive && props.activeId === id && request === enableRequest && (!automatic || props.autoLoad)
    if (anime.selected.value) return false
    await activeRuntime()?.activate()
    if (!current() || anime.selected.value) return false
    await live2d.enable()
    return current()
  }

  function setSpeaking(value: boolean) {
    anime.setSpeaking(value)
    live2d.setSpeaking(value)
    if (!value && stageRef.value) {
      stageRef.value.dataset.mouthLevel = '0.000'
      stageRef.value.dataset.audioPeak = '0.000'
    }
  }

  function setMouth(value: number) {
    if (stageRef.value) stageRef.value.dataset.mouthLevel = Math.max(0, Math.min(1, value)).toFixed(3)
    anime.setMouth(value)
    live2d.setMouth(value)
  }

  function setAudioLevel(level: number, peak = level) {
    if (stageRef.value) stageRef.value.dataset.audioPeak = Math.max(0, Math.min(1, peak)).toFixed(3)
    anime.setAudioLevel(level, peak)
    live2d.setAudioLevel(level, peak)
  }

  function setEmotion(value: string) {
    emotion.value = value
    anime.setEmotion(value)
    activeRuntime()?.pushEmotion(value)
    live2d.syncNativeEmotion()
  }

  function setUserMessage() {
    activeRuntime()?.onUserMessage()
    live2d.syncNativeEmotion()
  }

  function setDesktopVisible(visible: boolean) {
    desktopVisible = visible
    updateStageVisibility()
  }

  function setDesktopWindowBounds(bounds: { x: number; y: number; width: number; height: number }) {
    live2d.setDesktopWindowBounds(bounds)
  }

  function setGlobalPointer(
    screenX: number,
    screenY: number,
    windowBounds: { x: number; y: number; width: number; height: number },
  ) {
    anime.setGlobalPointer(screenX, screenY, windowBounds)
    live2d.setGlobalPointer(screenX, screenY, windowBounds)
  }

  function releasePointerFocus() {
    anime.releasePointerFocus()
    live2d.releasePointerFocus()
  }

  let desktopBatteryPower: boolean | null = null
  function applyDesktopPerformanceMode() {
    if (desktopBatteryPower === null) return
    live2d.setMaxFps(desktopBatteryPower ? 30 : 0)
  }
  function setDesktopPerformanceMode(onBatteryPower: boolean) {
    anime.setBattery(onBatteryPower)
    desktopBatteryPower = Boolean(onBatteryPower)
    applyDesktopPerformanceMode()
  }
  watch(live2d.backendKind, applyDesktopPerformanceMode, { flush: 'sync' })

  async function handleOutfitChange(next: string) {
    if (outfitBusy.value) return
    if (normalizeCompanionOutfit(props.activeId, next) !== next) return
    const id = props.activeId
    const request = characterRequest
    outfitBusy.value = true
    try {
      if (await live2d.setOutfit(next) && currentCharacterRequest(id, request)) {
        outfitByChar.value = { ...outfitByChar.value, [id]: next }
        deps.emitOutfitChanged(next)
        deps.closeWardrobe()
      }
    } finally {
      outfitBusy.value = false
    }
  }

  async function synchronizeCharacter(id: string) {
    const request = ++characterRequest
    await anime.restore()
    if (!currentCharacterRequest(id, request) || anime.selected.value) return
    if (modelStudioOpen.value) deps.closeModelStudio()
    enableRequest++
    wardrobeOpen.value = false
    live2d.attachEmotionRuntime(activeRuntime())
    const remembered = normalizeCompanionOutfit(id, props.outfit)
    outfitByChar.value = { ...outfitByChar.value, [id]: remembered }
    if (!live2dInitialized.value) return
    if (live2d.enabled.value) await activeRuntime()?.activate()
    if (!currentCharacterRequest(id, request)) return
    await live2d.setCharacter(id)
    if (currentCharacterRequest(id, request) && props.autoLoad && !live2d.enabled.value) await enableCharacter(true)
    if (currentCharacterRequest(id, request) && remembered !== live2d.outfit.value) await live2d.setOutfit(remembered)
  }
  watch(() => props.activeId, id => { void synchronizeCharacter(id) }, { flush: 'sync' })

  watch(() => props.outfit, (value) => {
    // 外部（storage 恢复/其他标签页）带来的值只认当前角色的值空间
    const valid = normalizeCompanionOutfit(props.activeId, value)
    if (value !== valid || valid !== currentOutfitId()) {
      outfitByChar.value = { ...outfitByChar.value, [props.activeId]: valid }
      if (valid !== live2d.outfit.value) void live2d.setOutfit(valid)
    }
  })

  watch(() => props.autoLoad, (enabled) => {
    if (!enabled) {
      enableRequest++
      if (live2d.enabled.value) live2d.disable()
      return
    }
    if (live2d.enabled.value || anime.selected.value) return
    // Cold initialization adopts the latest preference after its own await.
    if (live2dInitialized.value) void enableCharacter(true)
  })

  watch(() => props.desktopWindowBounds, (bounds) => {
    if (bounds) live2d.setDesktopWindowBounds(bounds)
  }, { immediate: true })

  function resolvedBackendKind(): Live2DBackendKind {
    if (props.backend && props.backend !== 'auto') return props.backend
    try {
      const url = new URLSearchParams(window.location.search).get('live2dBackend')
      if (url === 'native' || url === 'browser') return url
      const dataset = document.documentElement.dataset.live2dBackend
      if (dataset === 'native' || dataset === 'browser') return dataset
    } catch { /* 非浏览器环境 */ }
    return 'browser'
  }

  onMounted(async () => {
    const host = live2dHostRef.value
    const stage = stageRef.value
    const id = props.activeId
    if (!stageAlive || !host || !stage) return
    live2d.attachEmotionRuntime(activeRuntime())
    const initialOutfit = normalizeCompanionOutfit(id, props.outfit)
    outfitByChar.value = { ...outfitByChar.value, [id]: initialOutfit }
    await live2d.init(id, host, stage, {
      // Prepare once; enable only after the latest selection and preference are known.
      autoLoad: false,
      outfit: initialOutfit,
      backendKind: resolvedBackendKind(),
    })
    if (!stageAlive) return
    live2dInitialized.value = true
    if (props.activeId !== id) await synchronizeCharacter(props.activeId)
    else await anime.restore()
    if (stageAlive && props.autoLoad && !anime.selected.value && !live2d.enabled.value) await enableCharacter(true)
  })

  onBeforeUnmount(() => { stageAlive = false; characterRequest++; enableRequest++ })
  onUnmounted(() => { live2d.attachEmotionRuntime(null); live2d.destroy() })

  const pet = useCharacterPetControls(() => props.activeId, live2d)
  const petControls = computed(() => anime.active.value
    ? { ready: true, motions: anime.motions, expressions: anime.expressions, hint: '试试表情和互动动作；移动鼠标，角色会先看向你，再轻轻转头。' }
    : pet.petControls.value)
  const playPetMotion = (id: string) => anime.active.value ? anime.playMotion(id) : pet.playPetMotion(id)
  const setPetExpression = (id: string) => anime.active.value ? anime.setExpression(id) : pet.setPetExpression(id)

  return {
    anime,
    live2d,
    emotion,
    avatarText,
    avatarState,
    avatarActionable,
    avatarActionTitle,
    outfitBusy,
    outfitOptions,
    activeOutfitLabel,
    stageSuspended,
    paintedModel,
    presentationReady,
    handleAvatarAction,
    handleOutfitChange,
    pet,
    petControls,
    playPetMotion,
    setPetExpression,
    setSpeaking,
    setMouth,
    setAudioLevel,
    setEmotion,
    setUserMessage,
    setDesktopVisible,
    setDesktopWindowBounds,
    setDesktopPerformanceMode,
    setGlobalPointer,
    releasePointerFocus,
  }
}
