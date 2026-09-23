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
import { computed } from 'vue'
import { useLive2DPreferences } from '@/composables/live2d/preferences'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'

const props = defineProps<{ native?: boolean }>()
const { quality, setQuality } = useLive2DPreferences()
const supported = computed(() => !props.native || !window.aicsLive2dNative || window.aicsLive2dNative.supportsTextureQuality === true)
const options = [
  { value: 'original', label: '原始', caption: '高清' },
  { value: 'standard', label: '标准', caption: '省内存' },
  { value: 'compact', label: '节能', caption: '小窗' },
] as const
const qualityHint = computed(() => options.find(option => option.value === quality.value)?.caption || '高清')
</script>

<style scoped>
.live2d-quality-control { min-width:0; margin:var(--s-3) 0 0; padding:0; border:0; color:var(--text-secondary); }
.live2d-quality-control legend { display:flex; align-items:baseline; justify-content:space-between; gap:var(--s-2); width:100%; margin-bottom:var(--s-2); padding:0; font-size:var(--fs-label-sm); }
.live2d-quality-control legend small { color:var(--text-muted); font-size:var(--fs-label-xs); }
.live2d-quality-options { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:var(--s-1); padding:var(--s-1); border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--bg-deep); }
.live2d-quality-option { display:grid; gap:2px; min-width:0; min-height:44px; place-content:center; padding:var(--s-1) var(--s-2); border:1px solid transparent; border-radius:var(--r-md); background:transparent; color:var(--text-secondary); font:inherit; cursor:pointer; text-align:center; }
.live2d-quality-option strong { font-size:var(--fs-label-sm); font-weight:650; }
.live2d-quality-option small { color:var(--text-muted); font-size:var(--fs-label-xs); }
.live2d-quality-option[aria-checked='true'] { border-color:color-mix(in srgb,var(--character-accent) 55%,var(--border-soft)); background:color-mix(in srgb,var(--character-accent) 14%,var(--bg-surface)); color:var(--text-primary); box-shadow:inset 0 1px 0 var(--glass-highlight); }
.live2d-quality-option[aria-checked='true'] small { color:color-mix(in srgb,var(--character-accent) 72%,var(--text-primary)); }
.live2d-quality-option:is(:hover,:focus-visible):not(:disabled) { border-color:var(--character-accent); color:var(--text-primary); }
.live2d-quality-option:focus-visible { outline:2px solid var(--character-accent); outline-offset:2px; }
.live2d-quality-option:disabled { color:var(--text-disabled); cursor:not-allowed; }
.live2d-quality-option:disabled small { color:var(--text-disabled); }
@media (forced-colors:active) { .live2d-quality-options { background:Canvas; border-color:CanvasText; } .live2d-quality-option[aria-checked='true'] { outline:2px solid Highlight; } }
</style>
