<!-- Site theme interaction adapted from https://lucianlabs.dev/uxui-prompt/ · MIT (c) 2026 Seokwoooo. -->
<template>
  <StudioTooltip :content="label">
    <button ref="button" class="app-theme-toggle" type="button" :aria-label="label" :aria-pressed="theme === 'dark'"
      :data-dark="theme === 'dark'" :data-reduced-motion="reduced" @click="toggle">
      <span class="theme-symbol" aria-hidden="true">
        <ArchiveIcon class="theme-sun" name="sun" /><ArchiveIcon class="theme-moon" name="moon" />
      </span>
    </button>
  </StudioTooltip>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, onDeactivated, ref } from 'vue'
import { useTheme } from '@/composables/useTheme'
import { useMotionPreference } from '@/composables/useMotionPreference'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
const { theme, toggleTheme, cancelThemeReveal } = useTheme()
const button = ref<HTMLButtonElement | null>(null)
const reduced = useMotionPreference()
const label = computed(() => theme.value === 'light' ? '切换为深色模式' : '切换为亮色模式')
function toggle(event: MouseEvent) { toggleTheme(event.currentTarget as HTMLButtonElement) }
const releaseReveal = () => cancelThemeReveal(button.value)
onBeforeUnmount(releaseReveal)
onDeactivated(releaseReveal)
</script>
<style scoped>
.app-theme-toggle { display:grid; place-items:center; flex:none; width:var(--control-height); height:var(--control-height); padding:0; border:1px solid transparent; border-radius:var(--r-md); color:var(--text-secondary); background:transparent; cursor:pointer; }
/* The icon morphs inside a stationary navigation target, in the atelier's line style. */
:root .app-theme-toggle:is(:hover,:active),:root[data-theme-style='terraria'] body .app-theme-toggle:active { transform:none; }
.theme-symbol { display:grid; place-items:center; transition:transform var(--motion-press) var(--ease-out); }
.theme-symbol .archive-icon { grid-area:1/1; width:22px; height:22px; transition:transform var(--motion-theme-reveal) var(--ease-theme-reveal),opacity var(--motion-control) var(--ease-out); }
.theme-moon { opacity:0; transform:rotate(45deg) scale(.4); }
.app-theme-toggle[data-dark='true'] .theme-sun { opacity:0; transform:rotate(-90deg) scale(.4); }
.app-theme-toggle[data-dark='true'] .theme-moon { opacity:1; transform:none; }
@media (hover:hover) and (pointer:fine) {
  .app-theme-toggle:hover { color:var(--text-primary); background:var(--bg-hover); }
}
.app-theme-toggle:active:not(:focus-visible) .theme-symbol { transform:scale(.9); }
.app-theme-toggle:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
.app-theme-toggle:focus-visible .theme-symbol { transition:none; }
.app-theme-toggle[data-reduced-motion='true'] * { transition:none; }
.app-theme-toggle[data-reduced-motion='true'] .theme-symbol { transform:none; }
@media (forced-colors:active) {
  .app-theme-toggle { color:ButtonText; }
  .app-theme-toggle:focus-visible { outline:2px solid Highlight; outline-offset:2px; }
}
</style>
