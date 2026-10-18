<template>
  <fieldset class="live2d-quality-control">
    <legend>
      <span>Live2D 画质</span>
      <small>{{ qualityHint }}</small>
    </legend>
    <StudioTooltip content="切换后重新加载模型，原始资源保持不变">
      <div
        class="live2d-quality-options"
        role="radiogroup"
        aria-label="Live2D 画质"
        :data-value="quality"
      >
        <button
          v-for="option in options"
          :key="option.value"
          type="button"
          role="radio"
          class="live2d-quality-option"
          :data-value="option.value"
          :aria-checked="quality === option.value"
          @click="setQuality(option.value)"
        >
          <strong>{{ option.label }}</strong>
          <small>{{ option.caption }}</small>
        </button>
      </div>
    </StudioTooltip>
  </fieldset>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useLive2DPreferences } from '@/composables/live2d/preferences'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'

const { quality, setQuality } = useLive2DPreferences()
const options = [
  { value: 'original', label: '原始', caption: '高清' },
  { value: 'standard', label: '标准', caption: '省内存' },
  { value: 'compact', label: '节能', caption: '小窗' },
] as const
const qualityHint = computed(() => options.find(option => option.value === quality.value)?.caption || '高清')
</script>

<style scoped src="@/assets/css/components/Live2DQualityControl-0.css"></style>
