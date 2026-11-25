<template>
  <aside class="character-card open-character-stage" :class="{ 'local-model-stage': getCompanionCharacter(activeId)?.tags?.includes('local-import') }" :data-character="activeId" :data-surface="surface" :style="framingStyle">

    <div
      ref="stageRef"
      class="portrait-stage"
      :class="[{ speaking, 'live2d-ready': paintedModel }, `emotion-${emotion}`]"
      :data-character="activeId"
      :data-emotion="emotion"
      :data-presence="presence || undefined"
      data-mouth-level="0.000"
      data-audio-peak="0.000"
      role="region" tabindex="-1"
      :aria-label="`${character.name}的角色舞台`"
    >
      <div class="room-signal">
        <span>{{ character.roomCode }}</span>
        <small>{{ character.roomMood }}</small>
      </div>
      <img v-if="portraitImage.src && !portraitFailed" v-bind="portraitImage" class="portrait-main" :class="{ 'portrait-decoded': portraitLoaded }" :alt="character.name" />
      <div v-if="!portraitLoaded && !portraitFailed && !paintedModel" class="stage-portrait-feedback stage-portrait-loading" role="status">
        <ArchiveIcon name="image" /><div><strong>{{ character.name }}</strong><span>{{ portraitImage.src ? '正在加载立绘…' : '暂无静态立绘，可加载动态立绘' }}</span></div>
      </div>
      <div v-if="portraitFailed && !paintedModel" class="stage-portrait-feedback stage-portrait-missing" data-companion-interactive role="status">
        <ArchiveIcon name="image" /><strong>{{ character.name }}</strong>
        <span>立绘暂未加载，对话仍可继续</span>
        <button type="button" class="btn btn-ghost btn-sm" @click="retryPortrait">重新加载立绘</button>
      </div>
      <div ref="animeHostRef" class="anime25d-host" :hidden="!anime.active.value || stageSuspended" aria-hidden="true"></div>
      <div ref="live2dHostRef" class="live2d-host" aria-hidden="true"></div>
      <div v-if="live2d.interactionHint.value" class="live2d-interaction-hint" aria-live="polite">
        {{ live2d.interactionHint.value }}
      </div>
      <StudioTooltip v-if="!anime.selected.value && avatarState !== 'idle'" anchor :content="avatarActionTitle">
        <button
          class="avatar-status"
          type="button"
          data-companion-interactive
          :data-state="avatarState"
          :disabled="!avatarActionable"
          @click="handleAvatarAction"
        >{{ avatarText }}</button>
      </StudioTooltip>
      <button
        v-if="!anime.selected.value && avatarState === 'idle'"
        class="live2d-enable-cta"
        type="button"
        @click.stop="handleAvatarAction"
      >
        <strong>加载{{ character.name }}动态立绘</strong>
        <small>按需下载模型</small>
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
      <button v-if="localStudio && surface !== 'companion'" type="button" class="btn btn-ghost" @click="openModelStudio">导入或校准模型</button>
      <CharacterStageSettings ref="controlsRef" :companion="surface === 'companion'" :character-id="activeId">
      <Anime25DSettings :runtime="anime" />
      <button v-if="localStudio && surface === 'companion'" type="button" class="btn btn-ghost" @click="openModelStudio">导入或校准模型</button>
      <details class="character-about">
        <StudioDisclosureSummary>关于{{ character.name }}</StudioDisclosureSummary>
        <p class="character-caption">{{ character.caption }}</p>
        <p class="character-description">{{ character.description }}</p>
      </details>
      <div
        v-if="live2d.ready.value"
        class="live2d-wardrobe"
        :class="{ open: wardrobeOpen }"
        @click.stop
        @keydown.esc="onWardrobeEscape"
      >
        <div
          v-if="outfitOptions.length <= 1"
          class="wardrobe-trigger wardrobe-static"
          role="status"
          :aria-label="`${character.name}当前只有${activeOutfitLabel}`"
        >
          <span class="wardrobe-symbol" aria-hidden="true"><ArchiveIcon name="wardrobe" /></span>
          <span class="wardrobe-copy">
            <strong>{{ activeOutfitLabel }}</strong>
          </span>
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
            <strong>{{ activeOutfitLabel }}</strong>
          </span>
          <ArchiveIcon class="wardrobe-chevron" name="chevron-down" aria-hidden="true" />
        </button>
        <div
          v-if="outfitOptions.length > 1 && wardrobeOpen"
          :id="`${activeId}-wardrobe-menu`"
          class="wardrobe-menu" data-fluid-glass v-content-motion:down="wardrobeOpen"
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
      <Live2DQualityControl />
      <button v-if="live2d.ready.value" type="button" class="btn btn-ghost" @click="handleAvatarAction">切换为静态立绘</button>
      <fieldset v-if="live2d.ready.value || anime.active.value" class="stage-framing">
        <legend>角色取景</legend>
        <label>大小 <input type="range" min="0.65" max="2.2" step="0.05" :value="framing.zoom" aria-label="角色大小" @input="updateFraming('zoom', Number(($event.target as HTMLInputElement).value))" /></label>
        <label>左右 <input type="range" min="-25" max="25" step="1" :value="framing.x" aria-label="角色左右位置" @input="updateFraming('x', Number(($event.target as HTMLInputElement).value))" /></label>
        <label>高低 <input type="range" min="-25" max="25" step="1" :value="framing.y" aria-label="角色高低位置" @input="updateFraming('y', Number(($event.target as HTMLInputElement).value))" /></label>
        <button class="btn btn-ghost" type="button" @click="resetFraming">恢复默认取景</button>
      </fieldset>
      <Live2DCapabilityReport v-if="live2d.adapterReport.value" :report="live2d.adapterReport.value" />
      </CharacterStageSettings>
    </div>
  </aside>
  <Teleport to="body">
    <dialog ref="modelStudioDialog" class="model-studio stage-model-studio" aria-label="模型导入与校准"
      @cancel.prevent.stop="closeModelStudio" @close="!modelStudioDialog?.open && closeModelStudio()" @click="isBackdropClick($event, modelStudioDialog) && closeModelStudio()">
      <header class="model-studio-heading"><div><small>LIVE2D</small><h2>模型导入与校准</h2></div><button class="btn btn-ghost" type="button" aria-label="关闭模型工作室" autofocus @click="closeModelStudio"><ArchiveIcon name="close" /></button></header>
      <!-- Keep the conditional body separate from its Reka portals in this dialog. -->
      <div class="stage-model-studio-body">
        <AsyncPanel v-if="modelStudioOpen" class="stage-model-studio-panel" :loader="loadModelStudio" label="模型工作室" v-slot="{ component }"><component :is="component" /></AsyncPanel>
      </div>
    </dialog>
  </Teleport>
</template>

<script setup lang="ts">
import { useRuntimeImage } from '@/composables/useRuntimeImage'
import { computed, defineAsyncComponent, ref } from 'vue'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'
import neneWallpaper from '@/assets/illustrations/nene-webchat-wallpaper.webp'
import natsumeWallpaper from '@/assets/illustrations/natsume-webchat-wallpaper.webp'
import neneCutout from '@/assets/illustrations/nene-companion-512.webp'
import natsumeCutout from '@/assets/illustrations/natsume-companion-512.webp'
import type { CharacterStageProps } from '../types/characterStage'
import Anime25DSettings from '@/components/Anime25DSettings.vue'
import { getCompanionCharacter } from '@/utils/companionRegistry'
import Live2DQualityControl from '@/components/Live2DQualityControl.vue'
import CharacterStageSettings from '@/components/CharacterStageSettings.vue'
import { useStageFraming } from '@/composables/chat/useStageFraming'
import { useCharacterStageBridge } from '@/composables/chat/useCharacterStageBridge'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { isBackdropClick, useFluidDialog } from '@/composables/useFluidDialog'
import '@/assets/css/character-stage.css'
import Live2DCapabilityReport from './Live2DCapabilityReport.vue'

const AsyncPanel = defineAsyncComponent(() => import('@/components/ui/AsyncPanel.vue'))
const loadModelStudio = () => import('./ModelStudio.vue')

const props = defineProps<CharacterStageProps>()

const emit = defineEmits<{
  select: [id: string]
  live2dEnabled: [enabled: boolean]
  outfitChanged: [outfit: string]
}>()

const stageRef = ref<HTMLElement>()
const animeHostRef = ref<HTMLElement>()
const live2dHostRef = ref<HTMLElement>()

const staticPortraitSource = computed(() => {
  if (props.surface === 'companion') {
    if (props.backend === 'native') {
      if (props.activeId === 'nene') return neneCutout
      if (props.activeId === 'natsume') return natsumeCutout
    }
    return props.character.image
  }
  return props.activeId === 'nene' ? neneWallpaper : props.activeId === 'natsume' ? natsumeWallpaper : props.character.image
})
const { image: portraitImage, loaded: portraitLoaded, failed: portraitFailed, retry: reloadPortrait } = useRuntimeImage(staticPortraitSource)
function retryPortrait() { stageRef.value?.focus({ preventScroll: true }); reloadPortrait() }

const controlsRef = ref<InstanceType<typeof CharacterStageSettings>>()
const localStudio = isLocalStudioHost()
const modelStudioOpen = ref(false)
const modelStudioDialog = ref<HTMLDialogElement | null>(null)
const modelStudioMotion = useFluidDialog(modelStudioDialog)
function openModelStudio() { modelStudioOpen.value = true; modelStudioMotion.open() }
function closeModelStudio() { modelStudioOpen.value = false; modelStudioMotion.close() }
function openSettings() { controlsRef.value?.open() }

const { framing, framingStyle, update: updateFraming, reset: resetFraming } = useStageFraming(computed(() => props.activeId), () => props.surface || 'room')

const wardrobeOpen = ref(false)
const wardrobeTriggerRef = ref<HTMLButtonElement>()
function onWardrobeEscape(event: KeyboardEvent) {
  if (!wardrobeOpen.value) return
  event.preventDefault()
  event.stopPropagation()
  closeWardrobe()
}
function closeWardrobe() {
  wardrobeOpen.value = false
  wardrobeTriggerRef.value?.focus()
}

const {
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
} = useCharacterStageBridge({
  props,
  stageRef,
  animeHostRef,
  live2dHostRef,
  modelStudioOpen,
  wardrobeOpen,
  portraitLoaded,
  portraitFailed,
  framing,
  closeModelStudio,
  closeWardrobe,
  emitLive2dEnabled: enabled => emit('live2dEnabled', enabled),
  emitOutfitChanged: outfit => emit('outfitChanged', outfit),
})

defineExpose({
  ...pet,
  presentationReady,
  petControls,
  playPetMotion,
  setPetExpression,
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

<style scoped src="@/assets/css/components/ChatCharacterStage-0.css"></style>
