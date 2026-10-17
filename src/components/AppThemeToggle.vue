<!-- Interaction adapted from Lucian UX/UI Prompt #021 · MIT (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#021 -->
<!-- Icon hover adapted from Lucian UX/UI Prompt #208 · MIT (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#208 -->
<template>
  <StudioTooltip :content="label">
    <button class="app-theme-toggle" type="button" :aria-label="label" :aria-pressed="theme === 'light'" :data-reduced-motion="reduced" @click="toggleTheme">
      <span class="theme-track" aria-hidden="true">
        <span class="theme-knob"><span class="theme-glyph"><ArchiveIcon class="theme-knob-sun" name="sun" /><ArchiveIcon class="theme-knob-moon" name="moon" /></span></span>
        <span class="theme-symbol theme-day"><span class="theme-glyph"><ArchiveIcon name="sun" /></span></span>
        <span class="theme-symbol theme-night"><span class="theme-glyph"><ArchiveIcon name="moon" /></span></span>
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
</script>
<style scoped>
.app-theme-toggle { display:grid; place-items:center; flex:none; width:56px; height:40px; padding:0; border:0; border-radius:var(--r-md); color:var(--text-secondary); background:transparent; cursor:pointer; }
/* The 56px navigation slot and click target stay fixed during every gesture. */
:root .app-theme-toggle:is(:hover,:active) { transform:none; }
:root[data-theme-style='terraria'] body .app-theme-toggle:active { transform:none; }
.theme-track { position:relative; display:block; width:52px; height:30px; border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--bg-deep); isolation:isolate; transition:transform var(--motion-press) var(--ease-out); }
/* The track is a paper surface even when its navigation host uses pale wood text. */
:root[data-theme-style='terraria'] .theme-track { --text-secondary:var(--terraria-paper-text-secondary); --accent:var(--terraria-paper-text-primary); }
.theme-knob { position:absolute; display:grid; place-items:center; z-index:1; left:2px; top:2px; width:24px; height:24px; border:1px solid var(--border-strong); border-radius:var(--r-sm); background:var(--bg-surface); color:var(--accent); box-shadow:var(--shadow-sm),inset 0 1px 0 var(--glass-highlight); transition:transform var(--motion-control) var(--ease-out); }
.theme-symbol { position:absolute; top:2px; display:grid; place-items:center; width:24px; height:24px; color:var(--text-secondary); }
.theme-day { left:2px; color:var(--accent); }
.theme-night { right:2px; }
.theme-glyph { display:grid; place-items:center; transition:transform var(--motion-hover) var(--ease-out); }
.app-theme-toggle .theme-track .archive-icon { width:15px; height:15px; transition:transform var(--motion-control) var(--ease-out),opacity var(--motion-hover) var(--ease-out); }
.theme-knob .archive-icon { grid-area:1/1; }
.theme-knob-moon { opacity:0; transform:rotate(-18deg) scale(.88); }
.theme-night .archive-icon { transform:rotate(-18deg) scale(.88); }
/* The plate and glyphs follow the current palette through repeated presses. */
:global(:root[data-theme='dark'] .theme-knob) { transform:translateX(22px); }
:global(:root[data-theme='dark'] .theme-knob-sun) { opacity:0; transform:rotate(35deg) scale(.88); }
:global(:root[data-theme='dark'] .theme-knob-moon) { opacity:1; transform:none; }
:global(:root[data-theme='dark'] .theme-day) { color:var(--text-secondary); }
:global(:root[data-theme='dark'] .theme-night) { color:var(--accent); }
:global(:root[data-theme='dark'] .theme-day .archive-icon) { transform:rotate(35deg) scale(.88); }
:global(:root[data-theme='dark'] .theme-night .archive-icon) { transform:none; }
@media (hover:hover) and (pointer:fine) {
  .app-theme-toggle:hover:where(:not(:focus-visible)) .theme-glyph { transform:translateY(-1px) scale(1.08); }
}
.app-theme-toggle:active:not(:focus-visible) .theme-track { transform:scale(.96); }
.app-theme-toggle:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
.app-theme-toggle:focus-visible .theme-glyph { transition:none; }
.app-theme-toggle[data-reduced-motion='true'] * { transition:none; }
.app-theme-toggle[data-reduced-motion='true'] .theme-glyph { transform:none; }
.app-theme-toggle[data-reduced-motion='true']:active .theme-track { transform:none; }
@media (forced-colors:active) {
  .app-theme-toggle:focus-visible { outline:2px solid Highlight; outline-offset:2px; }
  .theme-track { background:Canvas; border-color:ButtonText; }
  .theme-knob { background:Highlight; color:HighlightText; border-color:Highlight; box-shadow:none; }
  .theme-symbol { color:ButtonText !important; }
}
</style>
