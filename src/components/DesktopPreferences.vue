<template>
  <section v-if="isDesktop" id="control-personalization" class="desktop-preferences" aria-labelledby="desktop-preferences-title">
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
import { ref } from 'vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import { settingsRepository } from '@/storage/settingsRepository'
import { desktopPages, DESKTOP_START_PAGE_SETTING } from '@/storage/desktopPreferences'
const isDesktop = Boolean(window.companionDesktop)
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
.desktop-preferences { display: grid; gap: var(--s-3); padding: var(--s-5); margin-block: var(--s-5); border: 1px solid var(--border-soft); border-radius: var(--r-lg); background: var(--bg-surface); }
.desktop-preferences h2 { margin: 0 0 var(--s-2); color: var(--text-primary); font-size: var(--fs-body); }
.desktop-preferences p { margin: 0; color: var(--text-secondary); font-size: var(--fs-body-sm); }
.desktop-preferences label { color: var(--text-primary); }
.desktop-preferences select {
  width: 100%;
  min-height: 44px;
  padding: var(--s-3) var(--s-7) var(--s-3) var(--s-3);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-md);
  background-color: var(--bg-elevated);
  color: var(--text-primary);
  font: inherit;
  cursor: pointer;
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
  border-color: var(--accent);
}
.desktop-preferences select:focus-visible {
  border-color: var(--accent);
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
