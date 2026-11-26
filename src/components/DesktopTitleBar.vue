<template>
  <header class="desktop-titlebar" aria-label="窗口标题栏">
    <div class="titlebar-history" role="group" aria-label="页面历史">
      <StudioTooltip anchor content="后退">
        <button type="button" aria-label="后退" :disabled="!canBack" @click="navigate(-1)"><ArchiveIcon name="history-back" /></button>
      </StudioTooltip>
      <StudioTooltip anchor content="前进">
        <button type="button" aria-label="前进" :disabled="!canForward" @click="navigate(1)"><ArchiveIcon name="history-forward" /></button>
      </StudioTooltip>
    </div>
    <div class="titlebar-drag" data-tauri-drag-region>
      <img src="/assets/favicon.svg" width="22" height="22" alt="" draggable="false" />
      <strong>绘遇 · HUIYU</strong>
      <span v-if="pageTitle" class="titlebar-page">{{ pageTitle }}</span>
    </div>
    <div class="titlebar-tools" role="group" aria-label="画室快捷操作">
      <StudioTooltip content="全局搜索（Ctrl+K）">
        <button type="button" aria-label="全局搜索" aria-keyshortcuts="Control+K" @click="search"><ArchiveIcon name="search" /></button>
      </StudioTooltip>
      <div class="titlebar-status">
        <StudioTooltip :content="statusLabel">
          <button class="titlebar-task-count" type="button" :aria-label="`${statusLabel}，打开任务中心`" @click="openRuntimeTasks">
            <ArchiveIcon :name="connection === 'ready' ? 'success' : connection === 'starting' ? 'info' : 'warning'" />
            <span class="titlebar-connection">{{ connectionLabel }}</span>
            <span>{{ activeCount }}</span>
          </button>
        </StudioTooltip>
        <StudioTooltip anchor :content="companionVisible ? '隐藏桌宠' : '显示桌宠'">
          <button type="button" aria-label="显示桌宠" :aria-pressed="companionVisible ?? undefined" :disabled="companionVisible === null || companionBusy"
            @click="toggleCompanion"><ArchiveIcon name="character" /></button>
        </StudioTooltip>
      </div>
    </div>
    <DesktopWindowControls />
  </header>
  <DesktopFileDrop />
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import { openGlobalSearch } from '@/composables/useGlobalSearch'
import { useTaskCenter } from '@/composables/useTaskCenter'
import { useDesktopTaskFeedback } from '@/composables/useDesktopTaskFeedback'
import { useToast } from '@/composables/useToast'
import { getDesktopRuntime, onDesktopRuntime } from '@/platform/desktop/runtime'
import { desktopShell } from '@/platform/desktop/shell'
import DesktopWindowControls from './DesktopWindowControls.vue'
import DesktopFileDrop from './DesktopFileDrop.vue'

const route = useRoute()
const router = useRouter()
const { activeCount, openRuntimeTasks } = useTaskCenter()
const toast = useToast()
const connection = ref(getDesktopRuntime().connection)
const companionVisible = ref<boolean | null>(null)
const companionBusy = ref(false)
let removeCompanion: (() => void) | undefined
let removeRuntime: (() => void) | undefined
let companionRevision = 0

useDesktopTaskFeedback()

const pageTitle = computed(() => typeof route.meta.title === 'string' ? route.meta.title.trim() : '')
const canBack = computed(() => Boolean(route.fullPath && router.options.history.state.back))
const canForward = computed(() => Boolean(route.fullPath && router.options.history.state.forward))
const connectionLabel = computed(() => connection.value === 'ready' ? '网关已连接' : connection.value === 'starting' ? '正在连接网关' : '网关未连接')
const statusLabel = computed(() => `${connectionLabel.value}，${activeCount.value} 项进行中`)

function search(event: MouseEvent) {
  openGlobalSearch(event.detail ? 'pointer' : 'keyboard')
}

function navigate(offset: -1 | 1) {
  if (offset < 0 ? canBack.value : canForward.value) router.go(offset)
}

function onMouseHistory(event: MouseEvent) {
  if (event.defaultPrevented || (event.button !== 3 && event.button !== 4)) return
  event.preventDefault()
  navigate(event.button === 3 ? -1 : 1)
}

async function readCompanion() {
  const revision = companionRevision
  try {
    const value = await desktopShell.readCompanion()
    if (revision === companionRevision) companionVisible.value = value
  } catch { /* Keep the last confirmed state. */ }
}

async function toggleCompanion() {
  if (companionBusy.value) return
  companionBusy.value = true
  try { await desktopShell.toggleCompanion(); await readCompanion() }
  catch { toast.warning('桌宠暂时无法切换。') }
  finally { companionBusy.value = false }
}

onMounted(() => {
  removeRuntime = onDesktopRuntime(state => { connection.value = state.connection })
  removeCompanion = desktopShell.onCompanion(value => { companionRevision++; companionVisible.value = value })
  void readCompanion()
  window.addEventListener('focus', readCompanion)
  window.addEventListener('auxclick', onMouseHistory)
})
onUnmounted(() => {
  companionRevision++
  removeRuntime?.()
  removeCompanion?.()
  window.removeEventListener('focus', readCompanion)
  window.removeEventListener('auxclick', onMouseHistory)
})
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
  padding-inline: var(--s-2);
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
.titlebar-history,
.titlebar-tools,
.titlebar-status {
  display: flex;
  align-items: center;
  flex: none;
  -webkit-app-region: no-drag;
}
.titlebar-history { padding-inline-start: var(--s-1); }
.titlebar-tools { gap: var(--s-1); padding-inline-end: var(--s-2); }
.titlebar-status { border: 1px solid var(--border-soft); border-radius: var(--r-pill); }
.titlebar-history button,
.titlebar-tools button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--s-1);
  min-inline-size: 30px;
  min-block-size: 28px;
  padding: 0 var(--s-1);
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: var(--fs-label);
}
.titlebar-status button { min-block-size: 24px; border-radius: var(--r-pill); }
.titlebar-task-count { font-variant-numeric: tabular-nums; }
.titlebar-history button:hover:not(:disabled),
.titlebar-tools button:hover:not(:disabled),
.titlebar-tools button[aria-pressed='true'] { color: var(--text-primary); background: var(--bg-elevated); }
.titlebar-history button:disabled,
.titlebar-tools button:disabled { color: var(--text-disabled); }
.titlebar-history button:focus-visible,
.titlebar-tools button:focus-visible { outline: 2px solid var(--focus-color); outline-offset: -2px; }
@media (max-width: 600px) {
  .titlebar-page { display: none; }
}
@media (max-width: 720px) {
  .titlebar-connection { display: none; }
}
@media (max-width: 500px) {
  .titlebar-drag strong { display: none; }
}
</style>
