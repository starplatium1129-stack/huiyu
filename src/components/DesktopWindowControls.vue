<template>
  <div v-if="bridge" class="window-controls" role="group" aria-label="窗口操作">
    <StudioTooltip content="最小化">
      <button type="button" aria-label="最小化" @click="run('minimizeWindow')">
        <ArchiveIcon name="window-minimize" />
      </button>
    </StudioTooltip>
    <StudioTooltip :content="maximized ? '还原' : '最大化'">
      <button type="button" :aria-label="maximized ? '还原' : '最大化'" @click="run('toggleMaximizeWindow')">
        <ArchiveIcon :name="maximized ? 'window-restore' : 'window-maximize'" />
      </button>
    </StudioTooltip>
    <StudioTooltip content="关闭">
      <button class="window-close" type="button" aria-label="关闭" @click="run('closeWindow')">
        <ArchiveIcon name="window-close" />
      </button>
    </StudioTooltip>
  </div>
</template>

<script setup lang="ts">
import { onActivated, onDeactivated, onMounted, onUnmounted, ref } from 'vue'
import { getDesktopCapabilities } from '@/platform/desktop/capabilities'
import { useToast } from '@/composables/useToast'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'

const bridge = getDesktopCapabilities()
const toast = useToast()
const maximized = ref(false)
let subscription: number | null = null

async function run(action: 'minimizeWindow' | 'toggleMaximizeWindow' | 'closeWindow') {
  try { await bridge?.[action]() }
  catch { if (subscription !== null) toast.warning('窗口操作未完成，请重试。') }
}

async function start() {
  if (!bridge || subscription !== null) return
  let receivedEvent = false
  const id = bridge.onMaximizedChanged(value => {
    receivedEvent = true
    maximized.value = value
  })
  subscription = id
  try {
    const state = await bridge.getWindowState()
    if (subscription === id && !receivedEvent) maximized.value = state.maximized
  } catch { /* Keep the last known window state. */ }
}

function stop() {
  if (subscription !== null) bridge?.offMaximizedChanged(subscription)
  subscription = null
}

onMounted(start)
onActivated(start)
onDeactivated(stop)
onUnmounted(stop)
</script>

<style scoped>
.window-controls { display:flex; align-items:stretch; flex:none; -webkit-app-region:no-drag; }
.window-controls button {
  display:grid; place-items:center; flex:none; padding:0;
  width:46px; border:0; border-radius:0;
  background:transparent; color:var(--text-secondary); cursor:default;
}
.window-controls .archive-icon { width:15px; height:15px; }
.window-controls button:hover { background:var(--bg-elevated); color:var(--text-primary); }
.window-controls button:active { background:var(--bg-hover); }
.window-controls button:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
.window-controls .window-close:hover { background:var(--bg-elevated); color:var(--danger-text); }
@media (forced-colors:active) { .window-controls button:focus-visible { outline:2px solid Highlight; } }
</style>
