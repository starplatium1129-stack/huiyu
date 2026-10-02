<template>
  <section v-if="isDesktop" id="control-personalization" class="desktop-preferences tw:grid tw:gap-s-3 tw:p-s-5 tw:rounded-lg" aria-labelledby="desktop-preferences-title">
    <div>
      <h2 id="desktop-preferences-title">我的桌面工作台</h2>
      <p>从常用页面开始，外观沿用你选择的深浅主题。</p>
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
.desktop-preferences { margin-block: var(--s-5); border: 1px solid var(--border-soft); background: var(--bg-surface); }
.desktop-preferences h2 { margin: 0 0 var(--s-2); @apply tw:text-primary tw:text-body; }
.desktop-preferences p { @apply tw:m-0 tw:text-secondary tw:text-body-sm; }
.desktop-preferences label { @apply tw:text-primary; }
.desktop-preferences select {
  @apply tw:w-full tw:min-h-[44px];
  padding: var(--s-3) var(--s-7) var(--s-3) var(--s-3);
  border: 1px solid var(--border-soft);
  @apply tw:rounded-md tw:bg-elevated tw:text-primary;
  font: inherit;
  @apply tw:cursor-pointer;
  outline: none;
  -webkit-appearance: none;
  appearance: none;
  background-image:
    linear-gradient(45deg, transparent 50%, var(--text-muted) 50%),
    linear-gradient(135deg, var(--text-muted) 50%, transparent 50%);
  background-repeat: no-repeat;
  background-position:
    calc(100% - 14px) calc(50% - 1px),
    calc(100% - 10px) calc(50% - 1px);
  background-size: 5px 5px;
  transition: border-color var(--motion-hover) var(--ease-out);
}
.desktop-preferences select:hover {
  @apply tw:border-accent;
}
.desktop-preferences select:focus-visible {
  @apply tw:border-accent;
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
