<template>
  <section v-if="desktop && (connection !== 'ready' || saveFailed || recoveryAvailable)" class="runtime-notice tw:flex tw:items-center tw:justify-between tw:flex-wrap tw:gap-s-3 tw:text-primary" role="status" aria-live="polite">
    <p>{{ recoveryAvailable ? '另一窗口已清空聊天，旧内容未重新写入。本页未保存的草稿可以单独导出。' : saveFailed ? '资料保存尚未完成。请保持窗口打开，草稿会继续保留。' : '本机服务尚未连接，已打开的内容和草稿会保留。' }}</p>
    <button v-if="recoveryAvailable" class="btn btn-ghost btn-sm" type="button" @click="downloadRecovery">导出未保存草稿</button>
    <button v-if="saveFailed || connection !== 'ready'" class="btn btn-ghost btn-sm" type="button" :disabled="retrying" @click="retry">{{ retrying ? '正在重连…' : saveFailed ? '重试保存' : '重新连接' }}</button>
  </section>
</template>
<script setup lang="ts">
import { onUnmounted, ref } from 'vue'
import { getDesktopCapabilities } from '@/platform/desktop/capabilities'
import { getDesktopRuntime, onDesktopRuntime, refreshDesktopRuntime } from '@/platform/desktop/runtime'
import { flushProfileWrites, profileWriteStatus, hasProfileRecoveryData, exportProfileRecovery } from '@/platform/web/profileStorage'
import { downloadBlob } from '@/utils/downloadBlob'
const desktop = Boolean(getDesktopCapabilities())
const connection = ref(getDesktopRuntime().connection)
const saveFailed = ref(Boolean(profileWriteStatus().error) || (profileWriteStatus().blocked && connection.value === 'ready')), retrying = ref(false)
const recoveryAvailable = ref(hasProfileRecoveryData())
const stop = desktop ? onDesktopRuntime(state => { connection.value = state.connection }) : () => {}
const failed = () => { saveFailed.value = true; recoveryAvailable.value = hasProfileRecoveryData() }
function downloadRecovery() { downloadBlob(exportProfileRecovery(), '绘遇-未保存草稿.json') }
if (desktop) window.addEventListener('huiyu:profile-write-error', failed)
async function retry() {
  if (retrying.value) return
  retrying.value = true
  try { await refreshDesktopRuntime(); await flushProfileWrites(); saveFailed.value = false }
  catch { saveFailed.value = true }
  finally { retrying.value = false }
}
onUnmounted(() => { stop(); window.removeEventListener('huiyu:profile-write-error', failed) })
</script>
<style scoped>
@reference "../assets/css/tailwind.css";
.runtime-notice { padding: var(--s-3) var(--s-4); border-bottom: 1px solid var(--border-strong); background: var(--bg-surface); }
.runtime-notice p { @apply tw:m-0 tw:text-label tw:leading-body; }
.runtime-notice button:disabled { @apply tw:text-disabled; opacity: 1; }
</style>
