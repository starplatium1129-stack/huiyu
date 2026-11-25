<template>
  <header class="desktop-titlebar" aria-label="窗口标题栏">
    <div class="titlebar-drag" data-tauri-drag-region>
      <img src="/assets/favicon.svg" width="22" height="22" alt="" draggable="false" />
      <strong>绘遇 · HUIYU</strong>
      <span v-if="pageTitle" class="titlebar-page">{{ pageTitle }}</span>
    </div>
    <DesktopWindowControls />
  </header>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import DesktopWindowControls from './DesktopWindowControls.vue'

const route = useRoute()
const pageTitle = computed(() => typeof route.meta.title === 'string' ? route.meta.title.trim() : '')
</script>

<style scoped>
.desktop-titlebar {
  position: sticky;
  top: 0;
  z-index: var(--z-nav);
  display: flex;
  flex: none;
  block-size: var(--desktop-chrome-height);
  background: var(--nav-bg);
  border-block-end: 1px solid var(--border-soft);
  color: var(--text-primary);
}
.titlebar-drag {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-inline-size: 0;
  padding-inline: 14px;
  font-size: var(--fs-label);
  white-space: nowrap;
  user-select: none;
  -webkit-app-region: drag;
}
.titlebar-drag > * { pointer-events: none; }
.titlebar-drag img, .titlebar-drag strong { flex: none; }
.titlebar-drag strong { font-weight: 500; color: var(--text-secondary); }
.titlebar-page {
  padding-inline-start: 10px;
  border-inline-start: 1px solid var(--border-soft);
  color: var(--text-primary);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
}
@media (max-width: 600px) {
  .titlebar-page { display: none; }
}
</style>
