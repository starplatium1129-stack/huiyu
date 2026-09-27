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
  </section>
</template>

<script setup lang="ts">
import { getDesktopCapabilities } from '@/platform/desktop/capabilities'

import { ref } from 'vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import { settingsRepository } from '@/storage/settingsRepository'
import { desktopPages, DESKTOP_START_PAGE_SETTING } from '@/storage/desktopPreferences'
const isDesktop = Boolean(getDesktopCapabilities())
const startPage = ref(settingsRepository.get(DESKTOP_START_PAGE_SETTING) || '/')
const feedback = ref('')
function saveStartPageValue(value: string | number) {
  const parsed = DESKTOP_START_PAGE_SETTING.parse(String(value))
  if (!parsed) return
  settingsRepository.set(DESKTOP_START_PAGE_SETTING, parsed)
  const saved = settingsRepository.get(DESKTOP_START_PAGE_SETTING)
  startPage.value = saved || '/'
  feedback.value = saved === parsed ? '已保存，下次打开工作台时生效。' : '设置未能保存，请检查本地存储后重试。'
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
