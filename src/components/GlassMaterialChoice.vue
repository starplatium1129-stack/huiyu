<template>
  <fieldset class="glass-choice">
    <legend>玻璃材质</legend>
    <div class="glass-choice-grid" role="radiogroup" aria-label="玻璃材质">
      <button v-for="choice in choices" :key="choice.value" type="button" role="radio" class="glass-choice-option"
        :aria-checked="glassMode === choice.value" :data-value="choice.value" @click="setGlassMode(choice.value)">
        <span class="glass-choice-body">
          <span class="glass-choice-preview" :data-material="choice.value" aria-hidden="true"><span class="glass-choice-surface"><span></span><i></i><i></i></span></span>
          <strong>{{ choice.title }}</strong><small>{{ choice.description }}</small>
        </span>
        <span class="glass-choice-indicator" aria-hidden="true"><ArchiveIcon name="success" /></span>
      </button>
    </div>
    <p class="glass-choice-note" role="status">{{ glassMode === 'liquid' && effectiveGlassMode !== 'liquid' ? '辅助显示设置优先，当前使用清晰底色；关闭后恢复所选材质。' : glassMode === 'liquid' ? '导航和工具条呈现折射与透光，适合性能充裕的设备。环境不支持时自动回退为柔和玻璃。' : '细腻高光与稳定底色，不计算背景折射。适合日常使用和办公笔记本。' }}</p>
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
.glass-choice { min-width:0; margin:0; padding:0; border:0; }
.glass-choice legend { margin-bottom:var(--s-2); color:var(--text-secondary); font-size:var(--fs-body); }
.glass-choice-note { margin:0; color:var(--text-muted); font-size:var(--fs-label); line-height:var(--lh-loose); }
.glass-choice-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:var(--s-3); margin-bottom:var(--s-3); }
.glass-choice-option { position:relative; min-width:0; padding:0; border:0; border-radius:var(--r-lg); background:transparent; color:inherit; font:inherit; cursor:pointer; text-align:left; }
.glass-choice-body { display:grid; height:100%; gap:var(--s-2); padding:var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--bg-surface); }
.glass-choice-option[aria-checked='true'] .glass-choice-body { border-color:var(--accent); box-shadow:inset 0 0 0 1px var(--accent); }
.glass-choice-option:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }
.glass-choice-indicator { position:absolute; top:var(--s-3); right:var(--s-3); z-index:var(--z-raised); display:grid; width:20px; height:20px; place-items:center; border:1px solid var(--border-strong); border-radius:50%; background:var(--bg-elevated); color:transparent; }
.glass-choice-indicator .archive-icon { width:13px; height:13px; }
.glass-choice-option[aria-checked='true'] .glass-choice-indicator { border-color:var(--accent); background:var(--accent); color:var(--text-inverse); }
.glass-choice-body strong { color:var(--text-primary); font-size:var(--fs-body); font-weight:600; }
.glass-choice-body small { color:var(--text-secondary); font-size:var(--fs-label); line-height:var(--lh-loose); }
.glass-choice-preview { position:relative; display:grid; place-items:center; height:64px; overflow:hidden; border-radius:var(--r-md); background:radial-gradient(ellipse at 15% 80%,var(--accent) 0%,transparent 65%),linear-gradient(135deg,var(--bg-elevated),var(--accent-soft)); }
.glass-choice-surface { display:flex; align-items:center; gap:var(--s-2); width:80%; height:36px; padding:var(--s-2); box-sizing:border-box; border:1px solid var(--glass-edge); border-radius:var(--r-pill); background:var(--bg-surface); box-shadow:inset 0 1px var(--glass-highlight),var(--shadow-sm); }
.glass-choice-surface > span { width:40%; height:6px; border-radius:var(--r-pill); background:var(--text-muted); }
.glass-choice-surface i { width:8px; height:8px; border-radius:var(--r-pill); background:var(--accent); }
[data-material="liquid"] .glass-choice-surface { background:linear-gradient(140deg,var(--glass-highlight),transparent 45%),color-mix(in srgb,var(--bg-surface) 66%,transparent); box-shadow:inset 0 2px var(--glass-highlight),inset 0 -2px var(--glass-edge),var(--shadow-md); }
@media (forced-colors:active) { .glass-choice-body { background:Canvas; border-color:CanvasText; } .glass-choice-option[aria-checked='true'] .glass-choice-body { outline:2px solid Highlight; } .glass-choice-preview { display:none; } }
</style>
