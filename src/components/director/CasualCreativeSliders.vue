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
    <div class="casual-slider-group">
      <div class="casual-slider-label-row">
        <label :for="cfgSliderId" class="casual-slider-name">画面遵循强度 <small>CFG</small></label>
        <output :for="cfgSliderId" class="casual-slider-value">{{ currentCfg }}</output>
      </div>
      <input
        :id="cfgSliderId"
        type="range"
        :min="cfgMin"
        :max="cfgMax"
        step="0.5"
        :value="currentCfg"
        :disabled="disabled"
        class="casual-range-input"
        @input="onCfgInput"
      />
    </div>

    <div class="casual-slider-group">
      <div class="casual-slider-label-row">
        <label :for="stepsSliderId" class="casual-slider-name">采样精细度 <small>Steps</small></label>
        <output :for="stepsSliderId" class="casual-slider-value">{{ currentSteps }} 步</output>
      </div>
      <input
        :id="stepsSliderId"
        type="range"
        min="1"
        :max="stepsMax"
        step="1"
        :value="currentSteps"
        :disabled="disabled"
        class="casual-range-input"
        @input="onStepsInput"
      />
    </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, useId } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { resolveDrawCapabilities } from '@/utils/drawCapabilities'
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
const capabilities = computed(() => resolveDrawCapabilities(props.animaState.family, null, selectedModel.value?.capabilities))
const fixedSampling = computed(() => props.drawEngine !== 'sd' && capabilities.value.promptFormat === 'natural-language')
const cfgMin = computed(() => props.drawEngine === 'sd' ? 1 : 0.5)
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

function onCfgInput(event: Event) {
  const val = Number((event.target as HTMLInputElement).value)
  if (props.drawEngine === 'sd') {
    emit('update:sdParams', { ...props.sdParams, cfg: val })
    emit('touch-sd', 'cfg')
  } else {
    emit('patch-anima', { cfg: val })
  }
}

function onStepsInput(event: Event) {
  const val = Number((event.target as HTMLInputElement).value)
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
  @apply tw:p-s-3 tw:rounded-lg tw:grid tw:gap-s-3;
  background: var(--bg-surface);
  border: 1px solid var(--border-soft);
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
  background: var(--accent-soft);
  border: 1px solid var(--border-soft);
}

.casual-slider-group {
  @apply tw:grid tw:gap-s-1;
}

.casual-slider-label-row {
  @apply tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-s-2;
}

.casual-slider-name {
  @apply tw:text-secondary;
  font-size: var(--fs-label);
}

.casual-slider-value {
  @apply tw:font-medium tw:font-mono;
  font-size: var(--fs-label);
  color: var(--accent);
  font-variant-numeric: tabular-nums;
  min-inline-size:7ch;
  text-align:end;
  white-space:nowrap;
}

.casual-range-input {
  @apply tw:w-full;
}

.casual-slider-hint {
  @apply tw:m-0 tw:text-secondary tw:leading-body;
  font-size: var(--fs-label-xs);
}

.casual-creative-sliders.is-disabled .casual-slider-value {
  color: var(--text-disabled);
}
</style>
