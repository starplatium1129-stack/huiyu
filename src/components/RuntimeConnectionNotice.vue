<template>
  <section v-if="settingWriteState.error || desktop && (connection !== 'ready' || saveFailed || recoveryAvailable || gateway?.phase === 'failed')" class="runtime-notice tw:flex tw:items-center tw:justify-between tw:flex-wrap tw:gap-s-3 tw:text-primary" aria-label="本机服务">
    <p role="status">{{ settingWriteState.error || (recoveryAvailable ? '另一窗口已清空聊天，旧内容未重新写入。本页未保存的草稿可以单独导出。' : saveFailed ? '资料保存尚未完成。请保持窗口打开，草稿会继续保留。' : gatewayMessage) }}</p>
    <button v-if="recoveryAvailable" class="btn btn-ghost btn-sm" type="button" @click="downloadRecovery">导出未保存草稿</button>
    <button v-if="settingWriteState.error || saveFailed || desktop && !hostRecovery && connection !== 'ready'" class="btn btn-ghost btn-sm" type="button" :disabled="retrying" @click="retry">{{ retrying ? '正在处理…' : settingWriteState.error || saveFailed ? '重试保存' : '重新连接' }}</button>
    <button v-if="hostRecovery && (connection === 'unavailable' || gateway?.phase === 'failed')" class="btn btn-ghost btn-sm" type="button"
      :disabled="restarting || gateway?.phase === 'reconnecting'" @click="restartGateway">重启本机服务</button>
    <button v-if="hostRecovery && gateway?.phase === 'failed'" class="btn btn-ghost btn-sm" type="button" :disabled="exporting" @click="exportDiagnostics">导出脱敏诊断包</button>
  </section>
</template>
<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import { getDesktopCapabilities } from '@/platform/desktop/capabilities'
import { getDesktopRuntime, onDesktopRuntime, refreshDesktopRuntime } from '@/platform/desktop/runtime'
import { flushProfileWrites, profileWriteStatus, hasProfileRecoveryData, exportProfileRecovery } from '@/platform/web/profileStorage'
import { downloadBlob } from '@/utils/downloadBlob'
import { settingWriteState, retrySettingWrites } from '@/storage/settingWrites'
import { getDesktopRecovery, type GatewayRecovery } from '@/platform/desktop/recovery'
import { useDesktopDiagnostics } from '@/composables/useDesktopDiagnostics'
const desktop = Boolean(getDesktopCapabilities())
const hostRecovery = getDesktopRecovery()
const gateway = ref<GatewayRecovery>()
const restarting = ref(false)
const restartError = ref('')
const { exporting, exportDiagnostics } = useDesktopDiagnostics()
const gatewayObservation = hostRecovery?.observeGateway(status => {
  gateway.value = status
  restartError.value = ''
})
void gatewayObservation?.ready.catch(() => {})
const gatewayMessage = computed(() => {
  if (restartError.value) return restartError.value
  if (gateway.value?.phase === 'reconnecting') return '本机服务断开，正在恢复。已打开的内容和草稿会保留。'
  if (gateway.value?.phase === 'failed') {
    const reason = gateway.value.reason === 'childExited' ? '进程反复退出'
      : gateway.value.reason === 'authorization' ? '身份核验失败' : '启动或连接失败'
    return '本机服务连续恢复失败（' + reason + '）。可以重启服务或导出诊断包。'
  }
  return '本机服务尚未连接，已打开的内容和草稿会保留。'
})
const connection = ref(getDesktopRuntime().connection)
const saveFailed = ref(Boolean(profileWriteStatus().error) || (profileWriteStatus().blocked && connection.value === 'ready')), retrying = ref(false)
const recoveryAvailable = ref(hasProfileRecoveryData())
const stop = desktop ? onDesktopRuntime(state => {
  connection.value = state.connection
  if (state.connection === 'ready') synced()
}) : () => {}
const failed = () => { saveFailed.value = true; recoveryAvailable.value = hasProfileRecoveryData() }
function downloadRecovery() { downloadBlob(exportProfileRecovery(), '绘遇-未保存草稿.json') }
function synced() {
  const status = profileWriteStatus()
  saveFailed.value = Boolean(status.error) || status.pending || (status.blocked && connection.value === 'ready')
  recoveryAvailable.value = hasProfileRecoveryData()
}
if (desktop) {
  window.addEventListener('huiyu:profile-write-error', failed)
  window.addEventListener('huiyu:profile-sync-complete', synced)
}
async function retry() {
  if (retrying.value) return
  retrying.value = true
  try { if (desktop) await refreshDesktopRuntime(); await retrySettingWrites(); await flushProfileWrites(); synced() }
  catch { saveFailed.value = true }
  finally { retrying.value = false }
}
async function restartGateway() {
  if (!hostRecovery || restarting.value) return
  restarting.value = true
  restartError.value = ''
  try { await hostRecovery.retryGateway() }
  catch { restartError.value = '无法重启本机服务，可导出诊断包后查看。' }
  finally { restarting.value = false }
}
onUnmounted(() => {
  stop()
  gatewayObservation?.dispose()
  window.removeEventListener('huiyu:profile-write-error', failed)
  window.removeEventListener('huiyu:profile-sync-complete', synced)
})
</script>
<style scoped>
@reference "../assets/css/tailwind.css";
.runtime-notice { padding: var(--s-3) var(--s-4); border-bottom: 1px solid var(--border-strong); background: var(--bg-surface); }
.runtime-notice p { @apply tw:m-0 tw:text-label tw:leading-body; }
</style>
