<template>
<div v-if="operation" class="panel-card operation-panel" :class="operation.status">
        <div class="operation-head">
          <div>
            <div class="panel-kicker">操作进度</div>
            <strong class="panel-heading">{{ transfer ? setupOperationLabels[transfer.kind] : operation.label }}</strong>
          </div>
          <span class="op-state tw:inline-flex tw:items-center tw:gap-s-2"><StudioOrbitSpinner v-if="operation.status === 'running'" />{{ opStatusLabel }}</span>
        </div>
        <div v-if="operation.stages?.length" class="meter" role="progressbar" aria-label="已完成步骤" :aria-valuemin="0" :aria-valuemax="operation.stages.length" :aria-valuenow="opCompletedStages"><span class="meter-fill" :style="{ '--fill': opProgress + '%' }"></span></div>
        <p v-if="operation.stages?.length" class="tw:text-label-sm tw:text-secondary">已完成 {{ opCompletedStages }} / {{ operation.stages.length }} 步</p>
        <SetupTransferProgress v-if="transfer && operation.status === 'running' && !inSetupPanel"
          :title="operation.stages[operation.stageIndex] || setupOperationLabels[transfer.kind]" :phase="setupTransferPhase(transfer)"
          :received="transfer.downloadedBytes" :total="transfer.totalBytes" :current-file="transfer.currentFile" :message="operation.message">
          <RouterLink class="btn btn-ghost btn-sm" :to="{ query: route.query, hash: transfer.kind === 'prepare-pixai' ? '#control-interrogate' : '#control-inference' }">查看任务与取消</RouterLink>
        </SetupTransferProgress>
        <p v-else class="operation-msg">{{ operation.message }}</p>
        <RouterLink v-if="transfer && operation.status === 'running' && inSetupPanel" class="btn btn-ghost btn-sm" :to="{ query: route.query, hash: transfer.kind === 'prepare-pixai' ? '#control-interrogate' : '#control-inference' }">查看任务与取消</RouterLink>
        <div v-if="operation.stages?.length" class="operation-stages">
          <span
            v-for="(stage, i) in operation.stages" :key="stage"
            class="op-stage"
            :class="{ done: operation.status === 'completed' || i < opCompletedStages, current: i === operation.stageIndex && operation.status === 'running' }"
          >{{ stage }}</span>
        </div>
      </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import StudioOrbitSpinner from '@/components/ui/StudioOrbitSpinner.vue'
import SetupTransferProgress from './SetupTransferProgress.vue'
import { isInferenceSetupOperation } from '@/api/inferenceSetupApi'
import { isInterrogateSetupOperation } from '@/api/interrogateSetupApi'
import { setupOperationLabels, setupTransferPhase } from '@/utils/setupOperationProgress'
import { useControlContext } from '@/composables/useControlContext'
const props = defineProps<{ activeSection: string }>()
const route = useRoute()
const { status } = useControlContext()
const { operation, opStatusLabel, opCompletedStages, opProgress } = status
const transfer = computed(() => isInferenceSetupOperation(operation.value) || isInterrogateSetupOperation(operation.value) ? operation.value : null)
const transferSection = computed(() => transfer.value?.kind === 'prepare-pixai' ? 'control-interrogate' : 'control-setup')
const inSetupPanel = computed(() => !!transfer.value && props.activeSection === transferSection.value)
</script>
