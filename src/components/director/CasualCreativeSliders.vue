<template>
  <div class="casual-creative-sliders" :class="{ 'is-disabled': disabled }" role="region" aria-label="画面采样微调">
    <div class="casual-sliders-header">
      <span class="casual-sliders-title">
        <ArchiveIcon name="spark" />
        <span>画面微调</span>
      </span>
      <span class="casual-sliders-badge">{{ fixedSampling ? '固定参数' : '即时调整' }}</span>
    </div>

    <p v-if="fixedSampling" class="casual-slider-hint">固定采样参数：CFG {{ currentCfg }} · {{ currentSteps }} 步</p>
    <template v-else>
    <StudioSlider
      :id="cfgSliderId"
      :model-value="currentCfg"
      :min="cfgMin"
      :max="cfgMax"
      :step="0.5"
      :disabled="disabled"
      compact
      class="casual-range-input"
      @update:model-value="onCfgChange"
    >
      <template #label>画面遵循强度 <small>CFG</small></template>
    </StudioSlider>

    <StudioSlider
      :id="stepsSliderId"
      :model-value="currentSteps"
      :min="1"
      :max="stepsMax"
      :step="1"
      unit=" 步"
      :disabled="disabled"
      compact
      class="casual-range-input"
      @update:model-value="onStepsChange"
    >
      <template #label>采样精细度 <small>Steps</small></template>
    </StudioSlider>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, useId } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioSlider from '@/components/ui/StudioSlider.vue'
import type { DrawEngine } from '@/types/promptHistory'
import type { SDParams } from '@/utils/promptBuilderPersistence'
import type { AnimaGenerationState } from '@/types/anima'

const props = defineProps<{
  drawEngine: DrawEngine
  disabled?: boolean
  sdParams: SDParams
  animaState: AnimaGenerationState
}>()

const emit = defineEmits<{
  (e: 'update:sdParams', params: SDParams): void
  (e: 'touch-sd', key: keyof SDParams): void
  (e: 'patch-anima', patch: Partial<AnimaGenerationState>): void
}>()

const uid = useId()
const cfgSliderId = `${uid}-casual-cfg`
const stepsSliderId = `${uid}-casual-steps`
const selectedModel = computed(() => props.animaState.models.find(model => model.id === props.animaState.modelId))
const fixedSampling = computed(() => props.drawEngine !== 'sd' && selectedModel.value?.capabilities?.fixedSampling === true)
const cfgMin = computed(() => props.drawEngine === 'sd' ? 1 : props.drawEngine === 'krea2' ? 0 : 0.5)
const cfgMax = computed(() => props.drawEngine === 'sd' ? 20 : 10)
const stepsMax = computed(() => props.drawEngine === 'sd' ? 150 : 60)

const currentCfg = computed(() => {
  if (props.drawEngine === 'sd') {
    return props.sdParams.cfg ?? 7
  }
  return props.animaState.cfg ?? 6
})

const currentSteps = computed(() => {
  if (props.drawEngine === 'sd') {
    return props.sdParams.steps ?? 28
  }
  return props.animaState.steps ?? 28
})

function onCfgChange(val: number) {
  if (props.drawEngine === 'sd') {
    emit('update:sdParams', { ...props.sdParams, cfg: val })
    emit('touch-sd', 'cfg')
  } else {
    emit('patch-anima', { cfg: val })
  }
}

function onStepsChange(val: number) {
  if (props.drawEngine === 'sd') {
    emit('update:sdParams', { ...props.sdParams, steps: val })
    emit('touch-sd', 'steps')
  } else {
    emit('patch-anima', { steps: val })
  }
}
</script>

<style scoped>
@reference "../../assets/css/tailwind.css";

.casual-creative-sliders {
  @apply tw:pt-s-2 tw:grid tw:gap-s-3;
  background: transparent;
  border: 0;
}

.casual-sliders-header {
  @apply tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-s-2;
}

.casual-sliders-title {
  @apply tw:flex tw:items-center tw:gap-s-1 tw:font-semibold;
  font-size: var(--fs-label);
  color: var(--accent);
}

.casual-sliders-badge {
  @apply tw:text-secondary;
  font-size: var(--fs-label-xs);
  padding: 2px var(--s-2);
  border-radius: var(--r-pill);
  background: var(--bg-elevated);
  border: 1px solid var(--border-soft);
}

.casual-range-input {
  @apply tw:w-full;
}

.casual-slider-hint {
  @apply tw:m-0 tw:text-secondary tw:leading-body;
  font-size: var(--fs-label-xs);
}
</style>
