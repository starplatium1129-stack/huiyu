<template>
  <section v-if="isDesktop" id="control-personalization" class="desktop-preferences tw:grid tw:gap-s-3 tw:p-s-5 tw:rounded-xl" aria-labelledby="desktop-preferences-title">
    <div>
      <span class="desktop-preferences-kicker">桌面偏好</span>
      <h2 id="desktop-preferences-title">我的桌面工作台</h2>
    </div>
    <label for="desktop-start-page">打开工作台时</label>
    <StudioSelect
      id="desktop-start-page"
      :model-value="startPage"
      label="打开工作台时"
      :options="[...desktopPages, { value: 'last', label: '回到上次工作页' }]"
      @update:model-value="saveStartPageValue"
    />
    <p class="desktop-preferences-note" role="status">{{ feedback || '仅记住页面位置；从作品或场景打开时仍进入对应内容。' }}</p>
    <button v-if="saveFailed" type="button" class="btn btn-ghost btn-sm" @click="saveStartPageValue(startPage)">重试保存</button>
  </section>
</template>

<script setup lang="ts">
import { getDesktopCapabilities } from '@/platform/desktop/capabilities'

import { onBeforeUnmount, ref } from 'vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import { flushProfileWrites } from '@/platform/web/profileStorage'
import { settingsRepository } from '@/storage/settingsRepository'
import { desktopPages, DESKTOP_START_PAGE_SETTING } from '@/storage/desktopPreferences'
const isDesktop = Boolean(getDesktopCapabilities())
const startPage = ref(settingsRepository.get(DESKTOP_START_PAGE_SETTING) || '/')
const feedback = ref('')
const saveFailed = ref(false)
let saveGeneration = 0
onBeforeUnmount(() => { saveGeneration++ })

async function saveStartPageValue(value: string | number) {
  const parsed = DESKTOP_START_PAGE_SETTING.parse(String(value))
  if (!parsed) return
  const generation = ++saveGeneration
  startPage.value = parsed
  saveFailed.value = false
  feedback.value = '正在保存启动页，请稍候…'
  try {
    settingsRepository.set(DESKTOP_START_PAGE_SETTING, parsed)
    // Desktop reads are optimistic until the shared write queue confirms them.
    await flushProfileWrites()
    if (generation !== saveGeneration) return
    if (settingsRepository.get(DESKTOP_START_PAGE_SETTING) !== parsed) throw new Error('Start page was not saved')
    feedback.value = '已保存，下次打开工作台时生效。'
  } catch {
    if (generation !== saveGeneration) return
    saveFailed.value = true
    feedback.value = '启动页保存尚未确认，当前选择已保留，请重试保存。'
  }
}
</script>

<style scoped>
@reference "../assets/css/tailwind.css";
.desktop-preferences { min-width:0; border: 1px solid var(--border-soft); background: var(--bg-surface); }
.desktop-preferences-kicker { color:var(--text-muted); font-size:var(--fs-label-xs); }
.desktop-preferences h2 { margin:var(--s-2) 0 0; @apply tw:text-primary tw:text-title-sm; }
.desktop-preferences p { @apply tw:m-0 tw:text-secondary tw:text-label tw:leading-body; }
.desktop-preferences label { @apply tw:text-primary tw:text-label; }
.desktop-preferences .studio-select-wrapper { width:100%; min-width:0; }
.desktop-preferences :deep(.studio-select-trigger) { min-height:40px; }
.desktop-preferences .btn { justify-self:start; }
</style>
