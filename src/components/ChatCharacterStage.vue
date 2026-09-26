<template>
  <aside class="character-card open-character-stage" :class="{ 'local-model-stage': getCompanionCharacter(activeId)?.tags?.includes('local-import') }" :data-character="activeId" :data-surface="surface" :style="framingStyle">

    <div
      ref="stageRef"
      class="portrait-stage"
      :class="[{ speaking, 'live2d-ready': live2d.ready.value && live2d.loadedCharacter.value === activeId, 'touch-pulse': touchResonanceActive }, `emotion-${emotion}`]"
      :data-character="activeId"
      :data-emotion="emotion"
      :data-presence="presence || undefined"
      :data-mouth-level="mouthLevel.toFixed(3)"
      :data-audio-peak="audioPeak.toFixed(3)"
      role="region"
      :aria-label="`${character.name}的角色舞台`"
    >
      <div class="room-signal">
        <span>{{ character.roomCode }}</span>
        <small>{{ character.roomMood }}</small>
      </div>
      <img :crossorigin="runtimeResourceCors()" v-if="!portraitFailed" :key="staticPortraitSource" class="portrait-main" :src="resolveRuntimeUrl(staticPortraitSource)" :alt="character.name" @error="portraitFailed = true" />
      <span v-if="usesMoodPortrait && !portraitFailed && !live2d.ready.value" class="stage-reference-caption">陪伴氛围参考 · 既有场景样张</span>
      <div v-if="portraitFailed && !live2d.ready.value" class="stage-portrait-missing" role="status">
        <ArchiveIcon name="image" /><strong>{{ character.name }}</strong>
        <span>立绘暂未加载，对话仍可继续</span>
        <button type="button" class="btn btn-ghost btn-sm" @click="portraitFailed = false">重新加载立绘</button>
      </div>
      <div ref="live2dHostRef" class="live2d-host" aria-hidden="true"></div>
      <div class="voice-halo" aria-hidden="true"></div>
      <div v-if="live2d.interactionHint.value" class="live2d-interaction-hint" aria-live="polite">
        {{ live2d.interactionHint.value }}
      </div>
      <StudioTooltip anchor :content="avatarActionTitle">
        <button
          class="avatar-status"
          type="button"
          :data-state="avatarState"
          :disabled="!avatarActionable"
          @click="handleAvatarAction"
        >{{ avatarText }}</button>
      </StudioTooltip>
      <button
        v-if="avatarState === 'idle'"
        class="live2d-enable-cta"
        type="button"
        @click.stop="handleAvatarAction"
      >
        <span class="live2d-enable-cta-kicker">LIVE2D / ON DEMAND</span>
        <strong>加载{{ character.name }}动态立绘</strong>
        <small>点击后按需下载模型与动作</small>
      </button>
    </div>

    <div class="character-info">
      <div class="character-info-head">
        <strong class="character-name">{{ character.name }}</strong>
        <div class="character-status">
          <span class="status-dot" :class="statusKind"></span>
          <span>{{ chatStatusText }}</span>
        </div>
      </div>
      <button v-if="localStudio && surface !== 'companion'" type="button" class="btn btn-ghost" @click="modelStudioOpen = true">导入或校准模型</button>
      <CharacterStageSettings ref="controlsRef" :companion="surface === 'companion'" :character-id="activeId">
      <button v-if="localStudio && surface === 'companion'" type="button" class="btn btn-ghost" @click="modelStudioOpen = true">导入或校准模型</button>
      <details class="character-about">
        <summary>关于{{ character.name }}</summary>
        <p class="character-caption">{{ character.caption }}</p>
        <p class="character-description">{{ character.description }}</p>
      </details>
      <div
        v-if="live2d.ready.value"
        class="live2d-wardrobe"
        :class="{ open: wardrobeOpen }"
        @click.stop
        @keydown.esc.stop.prevent="closeWardrobe"
      >
        <div
          v-if="outfitOptions.length <= 1"
          class="wardrobe-trigger wardrobe-static"
          role="status"
          :aria-label="`${character.name}当前只有${activeOutfitLabel}`"
        >
          <span class="wardrobe-symbol" aria-hidden="true"><ArchiveIcon name="wardrobe" /></span>
          <span class="wardrobe-copy">
            <small>SINGLE COSTUME</small>
            <strong>{{ activeOutfitLabel }}</strong>
          </span>
          <span class="wardrobe-note">互动动作含原生图层效果</span>
        </div>
        <button
          v-else
          ref="wardrobeTriggerRef"
          class="wardrobe-trigger"
          type="button"
          :aria-expanded="wardrobeOpen"
          :aria-controls="`${activeId}-wardrobe-menu`"
          @click="wardrobeOpen = !wardrobeOpen"
        >
          <span class="wardrobe-symbol" aria-hidden="true"><ArchiveIcon name="wardrobe" /></span>
          <span class="wardrobe-copy">
            <small>WARDROBE</small>
            <strong>{{ activeOutfitLabel }}</strong>
          </span>
          <span class="wardrobe-chevron" aria-hidden="true">⌄</span>
        </button>
        <div
          v-if="outfitOptions.length > 1 && wardrobeOpen"
          :id="`${activeId}-wardrobe-menu`"
          class="wardrobe-menu"
          role="group"
          :aria-label="`${character.name}服装`"
        >
          <span class="wardrobe-menu-title">选择服装</span>
          <button
            v-for="option in outfitOptions"
            :key="option.id"
            class="wardrobe-option"
            type="button"
            :aria-pressed="outfit === option.id"
            :class="{ active: outfit === option.id }"
            :disabled="outfitBusy"
            @click="handleOutfitChange(option.id)"
          >
            <span>{{ option.label }}</span>
            <i aria-hidden="true"></i>
          </button>
        </div>
      </div>
      <Live2DQualityControl :native="live2d.backendKind.value === 'native'" />
      <button v-if="live2d.ready.value" type="button" class="btn btn-ghost" @click="handleAvatarAction">切换为静态立绘</button>
      <fieldset v-if="live2d.ready.value" class="stage-framing">
        <legend>角色取景</legend>
        <label>大小 <input type="range" min="0.65" max="2.2" step="0.05" :value="framing.zoom" aria-label="角色大小" @input="updateFraming('zoom', Number(($event.target as HTMLInputElement).value))" /></label>
        <label>左右 <input type="range" min="-25" max="25" step="1" :value="framing.x" aria-label="角色左右位置" @input="updateFraming('x', Number(($event.target as HTMLInputElement).value))" /></label>
        <label>高低 <input type="range" min="-25" max="25" step="1" :value="framing.y" aria-label="角色高低位置" @input="updateFraming('y', Number(($event.target as HTMLInputElement).value))" /></label>
        <button class="btn btn-ghost" type="button" @click="resetFraming">恢复默认取景</button>
      </fieldset>
      <details v-if="live2d.adapterReport.value" class="live2d-capability-report">
        <summary>{{ capabilitySummary }}</summary>
        <ul>
          <li v-for="item in live2d.adapterReport.value.items" :key="item.id" :data-state="item.status">
            <span>{{ capabilityLabels[item.id] }}</span>
            <strong>{{ capabilityStatusLabels[item.status] }}</strong>
            <small>{{ item.reason }}</small>
          </li>
        </ul>
      </details>
      </CharacterStageSettings>
    </div>
  </aside>
  <ModelStudio v-if="modelStudioOpen" @close="modelStudioOpen = false" />
</template>

<script setup lang="ts">
import { resolveRuntimeUrl, runtimeResourceCors } from '@/platform/runtimeUrl'

import { getNativeLive2dCapabilities } from '@/platform/desktop/nativeLive2d'

import { computed, defineAsyncComponent, onMounted, onUnmounted, ref, watch } from 'vue'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'
import { useMoodReferences } from '@/composables/useMoodReferences'
import {
  type CharacterConfig,
} from '@/config/characters'
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
import Live2DQualityControl from '@/components/Live2DQualityControl.vue'
import CharacterStageSettings from '@/components/CharacterStageSettings.vue'
import { useLive2DPreferences } from '@/composables/live2d/preferences'
import { useStageFraming, type StageSurface } from '@/composables/chat/useStageFraming'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import '@/assets/css/character-stage.css'
import { createEmotionRuntime, getEmotionRuntimeConfig, type EmotionRuntime } from '@/utils/emotionRuntime'
import { profileEmotionConfig } from '@/live2d/companionEmotion'
import type { Live2DBackendKind } from '@/live2d/types'
import type { Live2DAdapterCapabilityItem, Live2DCapabilityStatus } from '@/live2d/adapterProfile'

const companionCharacters = listCompanionUiCharacters()
const CHARACTER_IDS = listCompanionCharacterIds()

const props = defineProps<{
  activeId: string
  surface?: StageSurface
  suspended?: boolean
  character: CharacterConfig
  speaking: boolean
  chatStatusText: string
  statusKind: string
  autoLoad: boolean
  presence?: string
  desktopWindowBounds?: { x: number; y: number; width: number; height: number } | null
  outfit: string
  volume?: number
  /**
   * 渲染后端：'auto' 时按 html dataset `data-live2d-backend` 或 URL
   * `?live2dBackend=` 解析（桌面 Rust 壳注入用），默认浏览器 wl-live2d。
   * 原生后端不可用（桥缺失）时自动回退浏览器并标记 backend-fallback。
   */
  backend?: Live2DBackendKind | 'auto'
}>()

const emit = defineEmits<{
  select: [id: string]
  live2dEnabled: [enabled: boolean]
  outfitChanged: [outfit: string]
}>()

const stageRef = ref<HTMLElement>()
const portraitFailed = ref(false)
const { available: moodPortraits } = useMoodReferences(['sc001', 'sc022'])
const moodPortraitId = computed(() => props.activeId === 'nene' ? 'sc001' : props.activeId === 'natsume' ? 'sc022' : '')
const usesMoodPortrait = computed(() => (props.surface || 'room') === 'room' && moodPortraits.value.has(moodPortraitId.value))
const staticPortraitSource = computed(() => usesMoodPortrait.value ? `/scene-showcase/thumbs/${moodPortraitId.value}.jpg` : props.character.image)
watch(staticPortraitSource, () => { portraitFailed.value = false })
const controlsRef = ref<InstanceType<typeof CharacterStageSettings>>()
const ModelStudio = defineAsyncComponent(() => import('./ModelStudio.vue'))
const localStudio = isLocalStudioHost()
const modelStudioOpen = ref(false)
watch(modelStudioOpen, updateStageVisibility)
function openSettings() { controlsRef.value?.open() }
const { framing, framingStyle, update: updateFraming, reset: resetFraming } = useStageFraming(computed(() => props.activeId), () => props.surface || 'room')
const live2dHostRef = ref<HTMLElement>()
const emotion = ref('neutral')
const mouthLevel = ref(0)
const audioPeak = ref(0)
const avatarText = ref('检测 Live2D…')
const avatarState = ref('checking')
const avatarDetail = ref('')
const avatarRetryable = ref(false)
const outfitBusy = ref(false)
const wardrobeOpen = ref(false)
const wardrobeTriggerRef = ref<HTMLButtonElement>()
function closeWardrobe() {
  wardrobeOpen.value = false
  wardrobeTriggerRef.value?.focus()
}
const live2dInitialized = ref(false)
// 换装选择按角色记忆（宁宁/夏目共用 storage 单字段，值空间分离）
const outfitByChar = ref<Record<string, string>>({
  ...Object.fromEntries(CHARACTER_IDS.map(id => [id, getCompanionDefaultOutfit(id)])),
})
function currentOutfitId() {
  return outfitByChar.value[props.activeId] ?? props.outfit
}
const outfitOptions = computed(() =>
  listCompanionOutfits(props.activeId),
)
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
watch(framing, () => live2d.layout(), { deep: true, flush: 'post' })
let desktopVisible = true
watch(() => props.suspended, updateStageVisibility, { immediate: true })
function updateStageVisibility() {
  const visible = desktopVisible && !props.suspended && !modelStudioOpen.value
  live2d.setPaused(!visible)
  if (visible) void live2d.recover()
}
const capabilityLabels: Record<Live2DAdapterCapabilityItem['id'], string> = {
  mouth: '口型', blink: '眨眼', focus: '视线', emotions: '情绪', interactions: '互动',
  'hit-areas': '点击区', 'overlay-reset': '叠层复位',
}
const capabilityStatusLabels: Record<Live2DCapabilityStatus, string> = {
  detected: '已发现', 'needs-confirmation': '待实机', verified: '已验证',
  unsupported: '未配置', invalid: '配置无效',
}
const capabilitySummary = computed(() => {
  const report = live2d.adapterReport.value
  if (!report) return '模型能力'
  const unavailable = report.items.filter(item => item.status === 'unsupported' || item.status === 'invalid').length
  const pending = report.items.filter(item => item.status === 'detected' || item.status === 'needs-confirmation').length
  if (report.status === 'invalid') return '模型能力配置无效'
  if (unavailable || pending) {
    const parts = [unavailable ? `${unavailable} 项未配置` : '', pending ? `${pending} 项待实机` : ''].filter(Boolean)
    return `模型能力 · ${parts.join(' · ')}`
  }
  return '模型能力 · 已验证'
})
const { quality } = useLive2DPreferences()
watch([quality, live2d.backendKind], ([value, backend]) => {
  const legacyNative = backend === 'native' && getNativeLive2dCapabilities() && !getNativeLive2dCapabilities()!.supportsTextureQuality
  void live2d.setQuality(legacyNative ? 'original' : value)
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

const touchResonanceActive = ref(false)
let touchTimer: ReturnType<typeof setTimeout> | undefined

watch(live2d.interactionHint, (hint) => {
  if (hint && hint !== '这个动作正在进行中' && hint !== '动作没有启动，请重试') {
    touchResonanceActive.value = true
    if (touchTimer) clearTimeout(touchTimer)
    touchTimer = setTimeout(() => { touchResonanceActive.value = false }, 1400)
  }
})

const avatarActionable = computed(() =>
  avatarState.value !== 'checking'
    && avatarState.value !== 'loading'
    && (!live2d.enabled.value || live2d.ready.value || avatarRetryable.value)
)

const avatarActionTitle = computed(() => {
  if (avatarState.value === 'loading') return '正在加载 Live2D 动态模型'
  if (!live2d.enabled.value) return '按需下载并启用 Live2D 动态模型'
  if (live2d.ready.value) return '切换回静态立绘并释放 Live2D 资源'
  return avatarDetail.value
})

async function handleAvatarAction() {
  if (!live2d.enabled.value) {
    await activeRuntime()?.activate()
    await live2d.enable()
    emit('live2dEnabled', true)
    return
  }
  if (live2d.ready.value) {
    emit('live2dEnabled', false)
    live2d.disable()
    return
  }
  if (avatarRetryable.value) await live2d.retry()
}

function setSpeaking(value: boolean) {
  live2d.setSpeaking(value)
  if (!value) {
    mouthLevel.value = 0
    audioPeak.value = 0
  }
}

function setMouth(value: number) {
  mouthLevel.value = Math.max(0, Math.min(1, value))
  live2d.setMouth(value)
}

function setAudioLevel(level: number, peak = level) {
  audioPeak.value = Math.max(0, Math.min(1, peak))
  live2d.setAudioLevel(level, peak)
}

function setEmotion(value: string) {
  emotion.value = value
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
  live2d.setGlobalPointer(screenX, screenY, windowBounds)
}

function releasePointerFocus() {
  live2d.releasePointerFocus()
}

let desktopBatteryPower: boolean | null = null
function applyDesktopPerformanceMode() {
  if (desktopBatteryPower === null) return
  // 原生后端：电池 30fps，接电恢复 165fps；browser 后端维持 60fps 上限。
  const native = live2d.backendKind.value === 'native'
  live2d.setMaxFps(desktopBatteryPower ? 30 : (native ? 165 : 60))
}
function setDesktopPerformanceMode(onBatteryPower: boolean) {
  desktopBatteryPower = Boolean(onBatteryPower)
  applyDesktopPerformanceMode()
}
watch(live2d.backendKind, applyDesktopPerformanceMode, { flush: 'sync' })

async function handleOutfitChange(next: string) {
  if (outfitBusy.value) return
  if (normalizeCompanionOutfit(props.activeId, next) !== next) return
  outfitBusy.value = true
  try {
    if (await live2d.setOutfit(next)) {
      outfitByChar.value = { ...outfitByChar.value, [props.activeId]: next }
      emit('outfitChanged', next)
      closeWardrobe()
    }
  } finally {
    outfitBusy.value = false
  }
}

watch(() => props.activeId, (id) => {
  wardrobeOpen.value = false
  live2d.attachEmotionRuntime(activeRuntime())
  const remembered = normalizeCompanionOutfit(id, props.outfit)
  outfitByChar.value = { ...outfitByChar.value, [id]: remembered }
  void (async () => {
    if (live2d.enabled.value) await activeRuntime()?.activate()
    await live2d.setCharacter(id)
    if (props.activeId === id && remembered !== live2d.outfit.value) await live2d.setOutfit(remembered)
  })()
})

watch(() => props.outfit, (value) => {
  // 外部（storage 恢复/其他标签页）带来的值只认当前角色的值空间
  const valid = normalizeCompanionOutfit(props.activeId, value)
  if (value !== valid || valid !== currentOutfitId()) {
    outfitByChar.value = { ...outfitByChar.value, [props.activeId]: valid }
    if (valid !== live2d.outfit.value) void live2d.setOutfit(valid)
  }
})

let pendingAutoLoad = false

watch(() => props.autoLoad, (enabled) => {
  if (!enabled || live2d.enabled.value) return
  // init 尚未完成时先记下请求，init 完成后统一按最新 autoLoad 决定，
  // 避免桌面 Companion 的 getState 异步完成落在 init 之前把事件丢掉。
  if (!live2dInitialized.value) {
    pendingAutoLoad = true
    return
  }
  void (async () => {
    await activeRuntime()?.activate()
    await live2d.enable()
  })()
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

onMounted(() => {
  if (!live2dHostRef.value || !stageRef.value) return
  live2d.attachEmotionRuntime(activeRuntime())
  const initialOutfit = normalizeCompanionOutfit(props.activeId, props.outfit)
  outfitByChar.value = { ...outfitByChar.value, [props.activeId]: initialOutfit }
  void (async () => {
    if (props.autoLoad) await activeRuntime()?.activate()
    await live2d.init(props.activeId, live2dHostRef.value!, stageRef.value!, {
      autoLoad: props.autoLoad,
      outfit: initialOutfit,
      backendKind: resolvedBackendKind(),
    })
    live2dInitialized.value = true
    if ((props.autoLoad || pendingAutoLoad) && !live2d.enabled.value) {
      pendingAutoLoad = false
      await activeRuntime()?.activate()
      await live2d.enable()
    }
  })()
})

onUnmounted(() => {
  clearTimeout(touchTimer)
  live2d.attachEmotionRuntime(null)
  live2d.destroy()
})

defineExpose({
  openSettings,
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
})
</script>

<style scoped>
.character-card .character-tabs { max-width: calc(100% - 24px); overflow-x: auto; }
.character-card .character-tab { flex-shrink: 0; white-space: nowrap; }
.character-card .character-tab.active { color: var(--text-primary); border-color: var(--border-strong); background: var(--bg-surface); }
.live2d-capability-report { margin-top: 8px; color: var(--text-secondary); font-size: 12px; }
.live2d-capability-report summary { min-height: 32px; cursor: pointer; color: var(--text-primary); }
.live2d-capability-report ul { display: grid; gap: 6px; margin: 6px 0 0; padding: 0; list-style: none; }
.live2d-capability-report li { display: grid; grid-template-columns: minmax(4em, auto) auto; gap: 2px 8px; }
.live2d-capability-report strong { color: var(--text-primary); font-weight: 650; }
.live2d-capability-report small { grid-column: 1 / -1; color: var(--text-secondary); overflow-wrap: anywhere; }
</style>
