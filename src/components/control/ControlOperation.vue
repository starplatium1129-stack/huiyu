<template>
  <div v-if="operation" class="panel-card operation-panel" :class="opDisconnected ? 'disconnected' : operation.cancelled ? 'cancelled' : operation.status">
    <details v-if="operation.status === 'completed' && !opDisconnected" class="operation-history">
      <StudioDisclosureSummary><span>上次操作 · {{ transfer ? setupOperationLabels[transfer.kind] : operationTitle }}</span><span class="op-state">已完成</span></StudioDisclosureSummary>
      <div class="operation-detail" data-disclosure-content>
        <p v-if="operation.message" class="operation-msg">{{ operation.message }}</p>
        <div v-if="operation.stages?.length" class="operation-stages"><span v-for="stage in operation.stages" :key="stage" class="op-stage done">{{ stage }}</span></div>
      </div>
    </details>
    <template v-else>
    <div class="operation-head">
      <div>
        <strong class="panel-heading">{{ transfer ? setupOperationLabels[transfer.kind] : operationTitle }}</strong>
      </div>
      <div class="operation-controls">
        <span class="op-state tw:inline-flex tw:items-center tw:gap-s-2">
          <StudioOrbitSpinner v-if="operation.status === 'running'" />{{ opStatusLabel }}
        </span>
        <button v-if="canCancelOperation" class="btn btn-quiet btn-sm" type="button" :disabled="operationCancelling" @click="cancelOperation">
          {{ operationCancelling ? '正在取消…' : '取消' }}
        </button>
      </div>
    </div>
    <div v-if="operation.stages?.length && !opDisconnected" class="meter" role="progressbar" aria-label="操作进度" :aria-valuemin="0" :aria-valuemax="100" :aria-valuenow="opProgress">
      <span class="meter-fill" :style="{ '--fill': opProgress + '%' }"></span>
    </div>
    <p v-if="operation.stages?.length && !opDisconnected" class="tw:text-label-sm tw:text-secondary">{{ opCompletedStages }} / {{ operation.stages.length }} 步</p>
    <SetupTransferProgress v-if="transfer && operation.status === 'running' && !inSetupPanel"
      :title="operation.stages[operation.stageIndex] || setupOperationLabels[transfer.kind]" :phase="setupTransferPhase(transfer)"
      :received="transfer.downloadedBytes" :total="transfer.totalBytes" :current-file="transfer.currentFile" :message="operation.message">
      <RouterLink class="btn btn-ghost btn-sm" :to="{ query: route.query, hash: transfer.kind === 'prepare-pixai' ? '#control-interrogate' : '#control-inference' }">查看任务与取消</RouterLink>
    </SetupTransferProgress>
    <div v-else-if="opDisconnected" class="operation-detail" role="status">
      <p class="operation-msg">上次启动已完成，但 ComfyUI 当前未连接。请重新启动；若仍无法连接，可查看启动日志。</p>
      <div class="operation-controls">
        <button class="btn btn-ghost btn-sm" type="button" :disabled="status.actionBusy.value || status.opBusy.value" @click="actions.serviceAction('comfy', 'start')">重新启动</button>
        <RouterLink class="btn btn-quiet btn-sm" :to="{ query: route.query, hash: '#control-logs' }">查看日志</RouterLink>
      </div>
    </div>
    <p v-else-if="operation.status !== 'running'" class="operation-msg">{{ operation.message }}</p>
    <div v-else-if="!transfer" class="operation-detail">
      <div class="operation-current-stage">
        <span>{{ operation.stages?.[operation.stageIndex] || '正在处理' }}</span>
        <span v-if="operation.workTotal" class="operation-work-count">（{{ operation.workDone ?? 0 }} / {{ operation.workTotal }}）</span>
      </div>
      <p v-if="operation.message" class="operation-msg">{{ operation.message }}</p>
    </div>
    <RouterLink v-if="transfer && operation.status === 'running' && inSetupPanel" class="btn btn-ghost btn-sm" :to="{ query: route.query, hash: transfer.kind === 'prepare-pixai' ? '#control-interrogate' : '#control-inference' }">查看任务与取消</RouterLink>
    <div v-if="operation.stages?.length && !opDisconnected" class="operation-stages">
      <span
        v-for="(stage, i) in operation.stages" :key="stage"
        class="op-stage"
        :class="{
          done: operation.status === 'completed' || i < opCompletedStages,
          current: operation.status === 'running' && i === opCompletedStages
        }"
      >{{ stage }}</span>
    </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import StudioOrbitSpinner from '@/components/ui/StudioOrbitSpinner.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import SetupTransferProgress from './SetupTransferProgress.vue'
import { isInferenceSetupOperation } from '@/api/inferenceSetupApi'
import { isInterrogateSetupOperation } from '@/api/interrogateSetupApi'
import { setupOperationLabels, setupTransferPhase } from '@/utils/setupOperationProgress'
import { useControlContext } from '@/composables/useControlContext'
const props = defineProps<{ activeSection: string }>()
const route = useRoute()
const { status, actions } = useControlContext()
const { canCancelOperation, operationCancelling, cancelOperation } = actions
const { operation, opDisconnected, opStatusLabel, opCompletedStages, opProgress } = status
const operationTitle = computed(() => opDisconnected.value ? '上次启动绘图服务' : ({ 'prepare-environment': '准备运行环境', 'comfy-start': '启动绘图服务', 'comfy-stop': '停止绘图服务' })[operation.value?.kind as 'prepare-environment' | 'comfy-start' | 'comfy-stop'] ?? operation.value?.label)
const transfer = computed(() => isInferenceSetupOperation(operation.value) || isInterrogateSetupOperation(operation.value) ? operation.value : null)
const transferSection = computed(() => transfer.value?.kind === 'prepare-pixai' ? 'control-interrogate' : 'control-setup')
const inSetupPanel = computed(() => !!transfer.value && props.activeSection === transferSection.value)
</script>
