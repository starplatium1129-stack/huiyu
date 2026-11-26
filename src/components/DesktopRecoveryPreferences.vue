<script setup lang="ts">
import { onMounted, ref } from 'vue'
import ToggleSwitch from '@/components/visual/ToggleSwitch.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { useDesktopDiagnostics } from '@/composables/useDesktopDiagnostics'
import { getDesktopRecovery } from '@/platform/desktop/recovery'
import { getDesktopUpdater } from '@/platform/desktop/updater'

const recovery = getDesktopRecovery()
const updater = getDesktopUpdater()
const { exporting, exportDiagnostics } = useDesktopDiagnostics()
const isolation = ref<boolean>()
const clipboard = ref<boolean>()
const pending = ref(false)
const feedback = ref('')
const version = ref('')

onMounted(async () => {
  if (!recovery) return
  const state = await Promise.allSettled([
    recovery.getRendererIsolation(),
    recovery.getClipboardAwareness(),
    updater?.current() ?? Promise.resolve(''),
  ] as const)
  if (state[0].status === 'fulfilled') isolation.value = state[0].value
  if (state[1].status === 'fulfilled') clipboard.value = state[1].value
  if (state[2].status === 'fulfilled') version.value = state[2].value
  if (isolation.value === undefined || clipboard.value === undefined) feedback.value = '部分桌面偏好暂时无法读取'
})

async function save(part: 'isolation' | 'clipboard', value: boolean) {
  if (!recovery || pending.value) return
  pending.value = true
  try {
    if (part === 'isolation') {
      await recovery.setRendererIsolation(value)
      isolation.value = value
      feedback.value = '独立渲染将在下次启动时生效'
    } else {
      await recovery.setClipboardAwareness(value)
      clipboard.value = value
      feedback.value = value ? '已开启桌宠剪贴板感知' : '已关闭桌宠剪贴板感知'
    }
  } catch {
    feedback.value = '设置暂时无法保存，请重试'
  } finally {
    pending.value = false
  }
}

function checkUpdates() { window.dispatchEvent(new Event('aics:check-desktop-updates')) }
</script>

<template>
  <div v-if="recovery" class="desktop-recovery-preferences">
    <ToggleSwitch :model-value="isolation === true" :disabled="isolation === undefined || pending"
      @update:model-value="save('isolation', $event)">Live2D 独立渲染（实验功能，下次启动生效）</ToggleSwitch>
    <ToggleSwitch :model-value="clipboard === true" :disabled="clipboard === undefined || pending"
      @update:model-value="save('clipboard', $event)">桌宠剪贴板感知</ToggleSwitch>
    <p v-if="feedback" role="status">{{ feedback }}</p>
    <div class="desktop-recovery-actions">
      <button class="btn btn-ghost btn-sm" type="button" @click="checkUpdates"><ArchiveIcon name="refresh" />检查更新</button>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="exporting" @click="exportDiagnostics">
        {{ exporting ? '正在导出…' : '导出脱敏诊断包' }}
      </button>
      <span v-if="version">当前版本 {{ version }}</span>
    </div>
  </div>
</template>

<style scoped>
.desktop-recovery-preferences { display: grid; gap: var(--s-2); padding-block-start: var(--s-3); border-block-start: 1px solid var(--border-soft); }
.desktop-recovery-actions { display: flex; align-items: center; flex-wrap: wrap; gap: var(--s-2); }
.desktop-recovery-preferences :is(p, span) { margin: 0; color: var(--text-secondary); font-size: var(--fs-label); }
</style>
