<template>
<section class="panel-card log-panel" aria-labelledby="control-log-title">
        <header class="panel-summary">
          <span id="control-log-title" class="log-summary-title"><ArchiveIcon name="book" /> 运行日志</span>
          <span class="summary-state">{{ logsSummary }}</span>
        </header>
        <div data-disclosure-content class="log-wrap" :aria-busy="logsLoading">
          <div class="log-toolbar" role="group" aria-label="日志操作">
            <StudioTooltip anchor content="仅保存版本与运行状态，不包含密钥、聊天正文或图片">
              <button class="btn btn-ghost btn-sm" type="button" :disabled="exportingDiag" @click="exportDiag">{{ exportingDiag ? '正在整理…' : '导出诊断包' }}</button>
            </StudioTooltip>
            <button class="btn btn-ghost btn-sm" type="button" :disabled="logsLoading" :aria-busy="logsLoading" @click="retryLogs">{{ logsLoading ? '读取中…' : '重新读取' }}</button>
            <button class="btn btn-ghost btn-sm" type="button" :disabled="!logs.length" @click="clearLogs">清空显示</button>
          </div>
          <div v-if="logsError" class="control-alert" role="alert"><ArchiveIcon name="warning" /><span>{{ logsError }}</span></div>
          <div v-memo="[logs, logs.length, logsLoading, logsLoaded, logsError]" class="log-box" ref="logBoxEl" role="region" aria-label="运行日志输出" tabindex="0">
            <div v-if="!logs.length && !logsError" class="log-empty" role="status">{{ logsLoading ? '正在读取日志…' : logsLoaded ? '暂无日志。' : '尚未读取日志。' }}</div>
            <div v-for="(line, i) in logs" :key="i" :class="lineClass(line)">
              <span class="time">{{ line.slice(0, 10) }}</span> {{ line.slice(11) }}
            </div>
          </div>
        </div>
      </section>
</template>

<script setup lang="ts">
import { watch, onUnmounted } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import { useControlContext } from '@/composables/useControlContext'
const props = defineProps<{ active: boolean }>()
const { status, actions } = useControlContext()
const { logs, logBoxEl, logsOpen, logsLoading, logsLoaded, logsError, logsSummary, pollLogs, clearLogs, lineClass } = status
const { exportDiag, exportingDiag } = actions
watch(() => props.active, active => { logsOpen.value = active }, { immediate: true })
onUnmounted(() => { logsOpen.value = false })
function retryLogs() { if (!logsLoading.value) { logBoxEl.value?.focus(); void pollLogs() } }
</script>
