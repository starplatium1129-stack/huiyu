<!-- Interaction adapted from Lucian UX/UI Prompt #021 · MIT (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#021 -->
<template>
  <StudioTooltip :content="label">
    <button class="app-theme-toggle" type="button" :aria-label="label" :aria-pressed="theme === 'light'" :data-night="theme === 'dark'" :data-reduced-motion="reduced" @click="toggle">
      <span class="theme-sky" aria-hidden="true">
        <span class="theme-halo" />
        <span class="theme-stars"><i /><i /><i /></span>
        <span class="theme-clouds"><i /><i /></span>
        <span class="theme-knob"><ArchiveIcon class="theme-sun" name="sun" /><ArchiveIcon class="theme-moon" name="moon" /></span>
      </span>
    </button>
  </StudioTooltip>
</template>
<script setup lang="ts">
import { computed } from 'vue'
import { useTheme } from '@/composables/useTheme'
import { useMotionPreference } from '@/composables/useMotionPreference'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
const { theme, toggleTheme } = useTheme()
const reduced = useMotionPreference()
const label = computed(() => theme.value === 'light' ? '切换为深色模式' : '切换为亮色模式')
function toggle(event: MouseEvent) {
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect()
  toggleTheme({ x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 })
}
</script>
<style scoped>
.app-theme-toggle { display:grid; place-items:center; flex:none; width:56px; height:40px; padding:0; border:1px solid transparent; border-radius:var(--r-md); color:var(--text-secondary); background:transparent; cursor:pointer; transition:transform var(--motion-press) var(--ease-out); }
.theme-sky { position:relative; display:block; width:48px; height:28px; overflow:hidden; isolation:isolate; border:1px solid var(--border-strong); border-radius:var(--r-md); background:var(--bg-deep); }
.theme-halo { position:absolute; left:-2px; top:-2px; width:30px; height:30px; border-radius:50%; background:var(--accent-soft); transition:transform var(--motion-surface) var(--ease-out); }
.theme-knob { position:absolute; left:3px; top:3px; display:grid; place-items:center; width:20px; height:20px; border:1px solid var(--border-strong); border-radius:50%; background:var(--bg-surface); color:var(--accent); transition:transform var(--motion-surface) var(--ease-out); }
.theme-knob .archive-icon { position:absolute; width:14px; height:14px; transition:opacity var(--motion-hover) var(--ease-out); }
.theme-moon { opacity:0; transform:rotate(180deg); }
.theme-stars { position:absolute; inset:0; opacity:0; transform:translateY(-8px); transition:transform var(--motion-surface) var(--ease-out),opacity var(--motion-hover) var(--ease-out); }
.theme-stars i { position:absolute; width:2px; height:2px; border-radius:50%; background:var(--text-secondary); }
.theme-stars i:nth-child(1) { left:8px; top:7px; }
.theme-stars i:nth-child(2) { left:15px; top:16px; }
.theme-stars i:nth-child(3) { left:6px; top:19px; }
.theme-clouds { position:absolute; inset:0; transition:transform var(--motion-surface) var(--ease-out),opacity var(--motion-hover) var(--ease-out); }
.theme-clouds i { position:absolute; right:4px; top:10px; width:12px; height:5px; border:1px solid var(--border-strong); border-radius:var(--r-pill); background:var(--bg-surface); }
.theme-clouds i:nth-child(2) { right:1px; top:17px; width:17px; }
/* Follow the document palette, which changes inside the capture callback.
   The named knob remains a separate moving surface during the page reveal. */
:global(:root[data-theme='dark'] .theme-knob) { transform:translateX(20px) rotate(180deg); }
:global(:root[data-theme='dark'] .theme-halo) { transform:translateX(20px); }
:global(:root[data-theme='dark'] .theme-sun) { opacity:0; }
:global(:root[data-theme='dark'] .theme-moon) { opacity:1; }
:global(:root[data-theme='dark'] .theme-stars) { opacity:1; transform:none; }
:global(:root[data-theme='dark'] .theme-clouds) { opacity:0; transform:translateY(9px); }
:global(:root[data-theme-transition] .theme-knob) { view-transition-name:huiyu-theme-knob; }
:global(:root[data-theme-transition]::view-transition-group(huiyu-theme-knob)),
:global(:root[data-theme-transition]::view-transition-old(huiyu-theme-knob)),
:global(:root[data-theme-transition]::view-transition-new(huiyu-theme-knob)) { animation-duration:var(--motion-surface); animation-timing-function:var(--ease-out); }
.app-theme-toggle:hover .theme-sky { border-color:var(--accent); }
.app-theme-toggle:active { transform:scale(.94); }
.app-theme-toggle:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
.app-theme-toggle[data-reduced-motion='true'], .app-theme-toggle[data-reduced-motion='true'] * { transition:none; }
@media (forced-colors:active) { .app-theme-toggle:focus-visible { outline:2px solid Highlight; outline-offset:2px; } .theme-sky,.theme-knob,.theme-clouds i { border-color:ButtonText; background:Canvas; } .theme-knob { color:ButtonText; } }
</style>
