<script setup lang="ts">
import { computed, useId } from 'vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import ToggleSwitch from '@/components/visual/ToggleSwitch.vue'
import type { H3StepChoice, H3Steps, VideoModelStatus } from '@/api/videoApi'

const props = defineProps<{ model: VideoModelStatus; defaultSteps: H3Steps; issue: string; disabled?: boolean }>()
const choice = defineModel<H3StepChoice>('choice', { required: true })
const lightVae = defineModel<boolean>('lightVae', { required: true })
const id = useId()
const effective = computed(() => choice.value === 'auto' ? props.defaultSteps : choice.value)
const names = { 2: 'pi-H3 DWD · 2 步', 4: 'Turbo · 4 步', 8: 'Turbo · 8 步' }
const options = computed(() => [
  { value: 'auto', label: `自动 · ${names[props.defaultSteps]}` },
  ...([2, 4, 8] as const).map(value => {
    const ready = value === 2 ? props.model.h3Dwd : props.model.turboSteps?.includes(value)
    return { value, label: names[value] + (ready ? '' : '（待导入）'), disabled: !ready }
  }),
])
function choose(value: string | number) {
  if (value === 'auto' || value === 2 || value === 4 || value === 8) {
    choice.value = value
    if (value === 'auto') lightVae.value = true
  }
}
function chooseDecoder(value: boolean) {
  choice.value = effective.value
  lightVae.value = value
}
</script>

<template>
  <div class="field">
    <label :for="id" class="field-label">H3 采样配方</label>
    <StudioSelect :id="id" :model-value="choice" :options="options" :disabled="disabled" label="H3 采样配方"
      :aria-invalid="issue ? 'true' : undefined" :aria-describedby="issue || effective === 2 ? id + '-hint' : undefined"
      @update:model-value="choose" />
    <small v-if="issue" :id="id + '-hint'" class="field-hint" role="status">{{ issue }}</small>
    <small v-else-if="effective === 2" :id="id + '-hint'" class="field-hint">最后一步直接输出画面，音轨同步生成。</small>
  </div>
  <ToggleSwitch v-if="effective !== 2 && model.h3LightVae" :model-value="lightVae" :disabled="disabled"
    label="轻量视频解码" @update:model-value="chooseDecoder">
    <span><strong>轻量视频解码</strong><small>开启用 LightVAE，关闭用 H3 原版。</small></span>
  </ToggleSwitch>
</template>
