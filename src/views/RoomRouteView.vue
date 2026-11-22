<script setup lang="ts">
import AsyncPanel from '@/components/ui/AsyncPanel.vue'
import { loadRoom, type RoomPage } from '@/router/roomResources'
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { companionWindow, getDesktopCapabilities } from '@/platform/desktop/capabilities'
import { provideCompanionInput } from '@/composables/chat/useCompanionInput'

const props = defineProps<{ page: RoomPage; label: string }>()
const load = () => loadRoom(props.page)
const input = props.page === 'companion' ? provideCompanionInput() : undefined
const desktopPet = Boolean(input)
const timedOut = ref(false)
const panelFailed = ref(false)
const stop: (() => void)[] = []
let startupRevision = 0
const retryDocument = () => location.reload()
async function loadDesktopPet() {
  panelFailed.value = false
  try { return await load() }
  catch (error) { panelFailed.value = true; throw error }
}
watch(panelFailed, failed => { if (failed) input?.markReady('failed') }, { flush: 'post' })
onMounted(() => {
  if (!desktopPet) return
  stop.push(companionWindow.on('startup-timeout', () => { startupRevision++; timedOut.value = true }))
  stop.push(companionWindow.on('startup-recovered', () => { startupRevision++; timedOut.value = false }))
  const revision = startupRevision
  void getDesktopCapabilities()?.getState().then(state => { if (revision === startupRevision) timedOut.value = state.startupFailed }).catch(() => {})
})
onUnmounted(() => { startupRevision++; stop.forEach(remove => remove()) })
</script>

<template>
  <div v-if="desktopPet" class="companion-route-panel">
    <AsyncPanel :loader="loadDesktopPet" :label="label">
      <template #default="{ component }"><component :is="component" /></template>
      <template #feedback="{ failed, retried, retry, reload }">
        <button v-if="failed" class="btn companion-startup-retry" data-companion-interactive type="button" @click="retried ? reload() : retry()">
          {{ retried ? '重新打开桌宠' : '桌宠暂未加载，重试' }}
        </button>
      </template>
    </AsyncPanel>
    <button v-if="timedOut && !panelFailed" class="btn companion-startup-retry" data-companion-interactive type="button" @click="retryDocument">桌宠未就绪，重新打开</button>
  </div>
  <AsyncPanel v-else :key="page" :loader="load" :label="label">
    <template #default="{ component }"><component :is="component" /></template>
  </AsyncPanel>
</template>

<style>
.companion-route-panel { min-height:100dvh; }
.companion-route-panel > .async-panel > .async-panel-content { transform:none !important; animation:none !important; }
.companion-startup-retry {
  position:fixed; inset:auto auto var(--s-4) 50%; transform:translateX(-50%);
  z-index:var(--z-overlay); color:var(--text-primary); background:var(--bg-surface); border:1px solid var(--border-strong);
}
</style>
