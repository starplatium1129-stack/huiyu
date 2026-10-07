<template>
  <div v-if="report" class="sd-recovery">
    <div class="sd-recovery-title">{{ report.title }}</div>
    <div class="sd-recovery-copy">{{ report.message }}</div>
    <div class="sd-recovery-actions">
      <button
        v-if="report.action"
        class="btn btn-primary btn-sm"
        type="button"
        @click="emit('recover', report.action.id)"
      >{{ report.action.label }}</button>
      <button class="btn btn-ghost btn-sm" type="button" @click="emit('dismiss')">忽略</button>
    </div>
    <details v-if="report.details">
      <StudioDisclosureSummary>技术细节</StudioDisclosureSummary>
      <pre>{{ report.details }}</pre>
    </details>
  </div>
</template>

<script setup lang="ts">
import type { SDErrorReport, SDRecoveryId } from '@/utils/sdError'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import '@/assets/css/director/components/SDRecoveryPanel.css'

defineProps<{ report: SDErrorReport | null }>()
const emit = defineEmits<{
  recover: [id: SDRecoveryId]
  dismiss: []
}>()
</script>
