<template>
  <StudioTooltip :content="label">
    <button type="button" class="app-theme-toggle" :aria-label="label" :aria-pressed="theme === 'light'" @click="toggleTheme">
      <ArchiveIcon :name="theme === 'light' ? 'moon' : 'sun'" />
    </button>
  </StudioTooltip>
</template>
<script setup lang="ts">
import { computed } from 'vue'
import { useTheme } from '@/composables/useTheme'
import ArchiveIcon from './visual/ArchiveIcon.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
const { theme, toggleTheme } = useTheme()
const label = computed(() => theme.value === 'light' ? '切换为深色模式' : '切换为亮色模式')
</script>
<style scoped>
.app-theme-toggle { display: inline-grid; place-items: center; flex-shrink: 0; width: 40px; height: 40px; border: 1px solid var(--border-soft); border-radius: var(--r-pill); background: var(--bg-surface); color: var(--text-secondary); cursor: pointer; transition: transform var(--motion-control) var(--ease-out); }
.app-theme-toggle:hover { color: var(--accent); }
.app-theme-toggle:active { transform: scale(.94); }
.app-theme-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
