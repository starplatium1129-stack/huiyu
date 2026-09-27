<template>
  <fieldset class="glass-choice tw:min-w-0 tw:m-0 tw:p-0">
    <legend>玻璃材质</legend>
    <div class="glass-choice-grid tw:grid tw:gap-s-3 tw:mb-s-3" role="radiogroup" aria-label="玻璃材质">
      <button v-for="choice in choices" :key="choice.value" type="button" role="radio" class="glass-choice-option tw:relative tw:min-w-0 tw:p-0 tw:rounded-lg tw:cursor-pointer tw:text-left"
        :aria-checked="glassMode === choice.value" :data-value="choice.value" @click="setGlassMode(choice.value)">
        <span class="glass-choice-body tw:grid tw:h-full tw:gap-s-2 tw:p-s-3 tw:rounded-lg">
          <span class="glass-choice-preview tw:relative tw:grid tw:h-[64px] tw:overflow-hidden tw:rounded-md" :data-material="choice.value" aria-hidden="true"><span class="glass-choice-surface tw:flex tw:items-center tw:gap-s-2 tw:w-[80%] tw:h-[36px] tw:p-s-2 tw:box-border tw:rounded-pill"><span></span><i></i><i></i></span></span>
          <strong>{{ choice.title }}</strong><small>{{ choice.description }}</small>
        </span>
        <span class="glass-choice-indicator tw:absolute tw:top-s-3 tw:right-s-3 tw:grid tw:w-[20px] tw:h-[20px]" aria-hidden="true"><ArchiveIcon name="success" /></span>
      </button>
    </div>
    <p class="glass-choice-note tw:m-0 tw:text-muted tw:text-label tw:leading-loose" role="status">{{ glassMode === 'liquid' && effectiveGlassMode !== 'liquid' ? '辅助显示设置优先，当前使用清晰底色；关闭后恢复所选材质。' : glassMode === 'liquid' ? '导航和工具条呈现折射与透光，适合性能充裕的设备。环境不支持时自动回退为柔和玻璃。' : '细腻高光与稳定底色，不计算背景折射。适合日常使用和办公笔记本。' }}</p>
  </fieldset>
</template>

<script setup lang="ts">
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { useDesktopPreferences, type GlassMode } from '@/composables/useDesktopInteraction'
const { glassMode, effectiveGlassMode, setGlassMode } = useDesktopPreferences()
const choices: Array<{ value: GlassMode; title: string; description: string }> = [
  { value: 'light', title: '轻盈玻璃', description: '默认 · 轻负担，清晰耐看' },
  { value: 'liquid', title: '液态玻璃', description: '高效果 · 折射，通透层次' },
]
</script>

<style scoped>
@reference "../assets/css/tailwind.css";
.glass-choice { border:0; }
.glass-choice legend { @apply tw:mb-s-2 tw:text-secondary tw:text-body; }
.glass-choice-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
.glass-choice-option { border:0; background:transparent; color:inherit; font:inherit; }
.glass-choice-body { border:1px solid var(--border-soft); background:var(--bg-surface); }
.glass-choice-option[aria-checked='true'] .glass-choice-body { @apply tw:border-accent; box-shadow:inset 0 0 0 1px var(--accent); }
.glass-choice-option:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }
.glass-choice-indicator { z-index:var(--z-raised); place-items:center; border:1px solid var(--border-strong); border-radius:50%; background:var(--bg-elevated); color:transparent; }
.glass-choice-indicator .archive-icon { @apply tw:w-[13px] tw:h-[13px]; }
.glass-choice-option[aria-checked='true'] .glass-choice-indicator { @apply tw:border-accent; background:var(--accent); @apply tw:text-inverse; }
.glass-choice-body strong { @apply tw:text-primary tw:text-body tw:font-semibold; }
.glass-choice-body small { @apply tw:text-secondary tw:text-label tw:leading-loose; }
.glass-choice-preview { place-items:center; background:radial-gradient(ellipse at 15% 80%,var(--accent) 0%,transparent 65%),linear-gradient(135deg,var(--bg-elevated),var(--accent-soft)); }
.glass-choice-surface { border:1px solid var(--glass-edge); background:var(--bg-surface); box-shadow:inset 0 1px var(--glass-highlight),var(--shadow-sm); }
.glass-choice-surface > span { @apply tw:w-[40%] tw:h-[6px] tw:rounded-pill; background:var(--text-muted); }
.glass-choice-surface i { @apply tw:w-[8px] tw:h-[8px] tw:rounded-pill; background:var(--accent); }
[data-material="liquid"] .glass-choice-surface { background:linear-gradient(140deg,var(--glass-highlight),transparent 45%),color-mix(in srgb,var(--bg-surface) 66%,transparent); box-shadow:inset 0 2px var(--glass-highlight),inset 0 -2px var(--glass-edge),var(--shadow-md); }
@media (forced-colors:active) { .glass-choice-body { background:Canvas; border-color:CanvasText; } .glass-choice-option[aria-checked='true'] .glass-choice-body { outline:2px solid Highlight; } .glass-choice-preview { @apply tw:hidden; } }
</style>
