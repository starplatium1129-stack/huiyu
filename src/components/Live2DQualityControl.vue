<template>
  <fieldset class="live2d-quality-control" :disabled="!supported">
    <legend>
      <span>Live2D 画质</span>
      <small>{{ supported ? qualityHint : '当前桌面版本仅支持原始资源' }}</small>
    </legend>
    <StudioTooltip :content="supported ? '切换后重新加载模型，原始资源保持不变' : '更新桌面程序后可选择其他画质'">
      <div
        class="live2d-quality-options"
        role="radiogroup"
        aria-label="Live2D 画质"
        :data-value="supported ? quality : 'original'"
      >
        <button
          v-for="option in options"
          :key="option.value"
          type="button"
          role="radio"
          class="live2d-quality-option"
          :data-value="option.value"
          :aria-checked="(supported ? quality : 'original') === option.value"
          :disabled="!supported"
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
import { getNativeLive2dCapabilities } from '@/platform/desktop/nativeLive2d'

import { computed } from 'vue'
import { useLive2DPreferences } from '@/composables/live2d/preferences'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'

const props = defineProps<{ native?: boolean }>()
const { quality, setQuality } = useLive2DPreferences()
const supported = computed(() => !props.native || !getNativeLive2dCapabilities() || getNativeLive2dCapabilities()!.supportsTextureQuality === true)
const options = [
  { value: 'original', label: '原始', caption: '高清' },
  { value: 'standard', label: '标准', caption: '省内存' },
  { value: 'compact', label: '节能', caption: '小窗' },
] as const
const qualityHint = computed(() => options.find(option => option.value === quality.value)?.caption || '高清')
</script>

<style scoped src="@/assets/css/components/Live2DQualityControl-0.css"></style>
