<template>
  <section v-if="isDesktop" ref="preferences" id="control-personalization" class="desktop-preferences tw:grid tw:gap-s-3 tw:p-s-5 tw:rounded-xl" aria-labelledby="desktop-preferences-title">
    <h2 id="desktop-preferences-title">桌面偏好</h2>
    <label for="desktop-start-mode">启动方式（下次启动生效）</label>
    <StudioSelect
      id="desktop-start-mode"
      :model-value="startupMode"
      label="启动方式"
      :options="startupModes"
      :disabled="startupBusy || startupMode === undefined"
      @update:model-value="saveStartupMode"
    />
    <p v-if="startupFeedback" role="status">{{ startupFeedback }}</p>
    <button v-if="startupReadFailed" class="btn btn-ghost btn-sm" type="button" @click="readStartupMode">重读启动方式</button>
    <label for="desktop-start-page">默认启动页</label>
    <StudioSelect
      id="desktop-start-page"
      :model-value="startPage"
      label="画室默认启动页"
      :options="[...desktopPages, { value: 'last', label: '回到上次工作页' }]"
      @update:model-value="saveStartPageValue"
    />
    <p v-if="feedback" class="desktop-preferences-note" role="status">{{ feedback }}</p>
    <button v-if="saveFailed" type="button" class="btn btn-ghost btn-sm" @click="retrySave">重试保存</button>
  </section>
</template>

<script setup lang="ts">
import { getDesktopCapabilities } from '@/platform/desktop/capabilities'

import { onBeforeUnmount, onMounted, ref } from 'vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import { flushProfileWrites } from '@/platform/web/profileStorage'
import { settingsRepository } from '@/storage/settingsRepository'
import { desktopPages, DESKTOP_START_PAGE_SETTING } from '@/storage/desktopPreferences'
import type { DesktopStartupMode } from '@/types/desktop'
const bridge = getDesktopCapabilities()
const isDesktop = Boolean(bridge)
const startupModes: { value: DesktopStartupMode; label: string }[] = [
  { value: 'companion', label: '仅桌宠' },
  { value: 'atelier', label: '仅主画室' },
  { value: 'both', label: '桌宠和画室同时启动' },
  { value: 'tray', label: '仅托盘静默启动' },
]
const startupMode = ref<DesktopStartupMode>()
const startupBusy = ref(false)
const startupReadFailed = ref(false)
const startupFeedback = ref('正在读取启动方式…')
async function readStartupMode() {
  if (!bridge || startupBusy.value) return
  startupBusy.value = true
  startupReadFailed.value = false
  try { startupMode.value = await bridge.getStartupMode(); startupFeedback.value = '' }
  catch { startupReadFailed.value = true; startupFeedback.value = '启动方式暂时无法读取。' }
  finally { startupBusy.value = false }
}
async function saveStartupMode(value: string | number) {
  const option = startupModes.find(mode => mode.value === value)
  if (!bridge || !option || startupBusy.value || startupMode.value === option.value) return
  startupBusy.value = true
  startupFeedback.value = '正在保存…'
  try {
    await bridge.setStartupMode(option.value)
    startupMode.value = option.value
    startupFeedback.value = '已保存，下次启动生效'
  } catch { startupFeedback.value = '保存失败，请重新选择。' }
  finally { startupBusy.value = false }
}
onMounted(readStartupMode)
const preferences = ref<HTMLElement | null>(null)
const startPage = ref(settingsRepository.get(DESKTOP_START_PAGE_SETTING) || '/')
const feedback = ref('')
const saveFailed = ref(false)
let saveGeneration = 0
onBeforeUnmount(() => { saveGeneration++ })
function retrySave(event: MouseEvent) {
  // The retry button disappears as saving starts; keep keyboard context on
  // the persistent choice before releasing that button.
  if (document.activeElement === event.currentTarget)
    preferences.value?.querySelector<HTMLElement>('[role="combobox"]')?.focus({ preventScroll: true })
  void saveStartPageValue(startPage.value)
}

async function saveStartPageValue(value: string | number) {
  const parsed = DESKTOP_START_PAGE_SETTING.parse(String(value))
  if (!parsed) return
  const generation = ++saveGeneration
  startPage.value = parsed
  saveFailed.value = false
  feedback.value = '保存中…'
  try {
    if (!await settingsRepository.set(DESKTOP_START_PAGE_SETTING, parsed)) throw new Error('启动页尚未保存')
    // Desktop reads are optimistic until the shared write queue confirms them.
    await flushProfileWrites()
    if (generation !== saveGeneration) return
    if (settingsRepository.get(DESKTOP_START_PAGE_SETTING) !== parsed) throw new Error('Start page was not saved')
    feedback.value = '已保存，下次启动生效'
  } catch {
    if (generation !== saveGeneration) return
    saveFailed.value = true
    feedback.value = '保存失败，请重试'
  }
}
</script>

<style scoped>
@reference "../assets/css/tailwind.css";
.desktop-preferences { min-width:0; border: 1px solid var(--border-soft); background: var(--bg-surface); }
.desktop-preferences h2 { margin:0; @apply tw:text-primary tw:text-title-sm; }
.desktop-preferences p { @apply tw:m-0 tw:text-secondary tw:text-label tw:leading-body; }
.desktop-preferences label { @apply tw:text-primary tw:text-label; }
.desktop-preferences .studio-select-wrapper { width:100%; min-width:0; }
.desktop-preferences .btn { justify-self:start; }
</style>
