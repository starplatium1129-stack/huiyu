<template>
  <fieldset class="glass-choice tw:min-w-0 tw:m-0 tw:p-0">
    <legend>玻璃材质</legend>
    <RadioGroupRoot v-model="selectedGlass" class="glass-choice-grid tw:grid tw:gap-s-3 tw:mb-s-3" aria-label="玻璃材质">
      <RadioGroupItem v-for="choice in choices" :key="choice.value" :value="choice.value" class="glass-choice-option tw:relative tw:min-w-0 tw:p-0 tw:rounded-lg tw:cursor-pointer tw:text-left"
        :data-value="choice.value" @focus="selectedGlass = choice.value">
        <span class="glass-choice-body tw:grid tw:h-full tw:gap-s-2 tw:p-s-3 tw:rounded-lg">
          <span class="glass-choice-preview tw:relative tw:grid tw:h-[64px] tw:overflow-hidden tw:rounded-md" :data-material="choice.value" aria-hidden="true"><span class="glass-choice-surface tw:flex tw:items-center tw:gap-s-2 tw:w-[80%] tw:h-[36px] tw:p-s-2 tw:box-border tw:rounded-pill"><span></span><i></i><i></i></span></span>
          <strong>{{ choice.title }}</strong>
        </span>
        <span class="glass-choice-indicator tw:absolute tw:top-s-3 tw:right-s-3 tw:grid tw:w-[20px] tw:h-[20px]" aria-hidden="true"><ArchiveIcon name="success" /></span>
      </RadioGroupItem>
    </RadioGroupRoot>
    <StudioSlider
      v-if="glassMode === 'liquid'"
      :id="tintId"
      class="glass-tint-control"
      :model-value="glassTint"
      :min="0"
      :max="100"
      :step="1"
      label="玻璃色调"
      unit="%"
      min-label="清透"
      max-label="加色"
      :disabled="effectiveGlassMode !== 'liquid'"
      :value-text="`玻璃色调 ${glassTint}%，越低越通透`"
      @update:model-value="setGlassTint"
    />
    <p v-if="glassMode === 'liquid' && effectiveGlassMode !== 'liquid'" class="glass-choice-note tw:m-0 tw:text-muted tw:text-label tw:leading-loose" role="status">辅助显示已启用</p>
  </fieldset>
</template>

<script setup lang="ts">
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioSlider from '@/components/ui/StudioSlider.vue'
import { computed, useId } from 'vue'
import { RadioGroupRoot, RadioGroupItem } from 'reka-ui'
import { useDesktopPreferences, type GlassMode } from '@/composables/useDesktopInteraction'
const { glassMode, effectiveGlassMode, glassTint, setGlassMode, setGlassTint } = useDesktopPreferences()
const tintId = useId()
const selectedGlass = computed({ get: () => glassMode.value, set: setGlassMode })
const choices: Array<{ value: GlassMode; title: string }> = [
  { value: 'light', title: '轻盈玻璃' },
  { value: 'liquid', title: '液态玻璃' },
]
</script>

<style scoped>
@reference "../assets/css/tailwind.css";
.glass-choice { border:0; }
.glass-choice legend { @apply tw:mb-s-2 tw:text-secondary tw:text-body; }
.glass-tint-control { margin:0 0 var(--s-3); }
.glass-choice-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
.glass-choice-option { border:0; background:transparent; color:inherit; font:inherit; }
.glass-choice-body { border:1px solid var(--border-soft); background:var(--bg-surface); }
.glass-choice-option[aria-checked='true'] .glass-choice-body { @apply tw:border-strong; box-shadow:var(--shadow-sm); }
.glass-choice-option:focus-visible { outline:none; box-shadow:var(--focus-shadow, 0 0 0 2px var(--focus-color, var(--text-secondary))); }
.glass-choice-indicator { z-index:var(--z-raised); place-items:center; border:1px solid var(--border-strong); border-radius:50%; background:var(--bg-elevated); color:transparent; }
.glass-choice-indicator .archive-icon { @apply tw:w-[13px] tw:h-[13px]; }
.glass-choice-option[aria-checked='true'] .glass-choice-indicator { @apply tw:border-strong; background:var(--bg-elevated); @apply tw:text-primary; }
.glass-choice-body strong { @apply tw:text-primary tw:text-body tw:font-semibold; }
.glass-choice-preview { place-items:center; background:radial-gradient(circle at 22% 76%,var(--accent) 0%,transparent 52%),radial-gradient(circle at 78% 24%,var(--archive-cyan,var(--accent-violet)) 0%,transparent 48%),linear-gradient(135deg,var(--bg-elevated),var(--accent-soft)); }
.glass-choice-surface { border:1px solid var(--glass-edge); background:var(--bg-surface); box-shadow:inset 0 1px var(--glass-highlight),var(--shadow-sm); }
.glass-choice-surface > span { @apply tw:w-[40%] tw:h-[6px] tw:rounded-pill; background:var(--text-muted); }
.glass-choice-surface i { @apply tw:w-[8px] tw:h-[8px] tw:rounded-pill; background:var(--accent); }
[data-material="liquid"] .glass-choice-surface {
  border-color:color-mix(in oklab,var(--on-art-primary) 64%,var(--glass-edge));
  background:
    linear-gradient(148deg,color-mix(in oklab,var(--on-art-primary) 42%,transparent) 0%,transparent 48%,color-mix(in oklab,var(--on-art-primary) 16%,transparent) 100%),
    color-mix(in oklab,var(--bg-surface) calc(44% + var(--glass-tint,.35) * 32%),transparent);
  box-shadow:
    inset 0 1px 0 color-mix(in oklab,var(--on-art-primary) 82%,transparent),
    inset 0 0 0 0.5px color-mix(in oklab,var(--on-art-primary) 42%,transparent),
    var(--shadow-md);
  -webkit-backdrop-filter:blur(14px) saturate(180%);
  backdrop-filter:blur(14px) saturate(180%);
}
@media (forced-colors:active) { .glass-choice-body { background:Canvas; border-color:CanvasText; } .glass-choice-option[aria-checked='true'] .glass-choice-body { outline:2px solid Highlight; } .glass-choice-preview { @apply tw:hidden; } }
</style>
