<script setup lang="ts">
import { computed } from 'vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import type { Live2DAdapterCapabilityItem, Live2DCapabilityStatus, Live2DAdapterCapabilityReport } from '@/live2d/adapterProfile'

const props = defineProps<{ report: Live2DAdapterCapabilityReport }>()
const capabilityLabels: Record<Live2DAdapterCapabilityItem['id'], string> = {
  mouth: '口型', blink: '眨眼', focus: '视线', emotions: '情绪', interactions: '互动',
  'hit-areas': '点击区', 'overlay-reset': '叠层复位',
}
const capabilityStatusLabels: Record<Live2DCapabilityStatus, string> = {
  detected: '已发现', 'needs-confirmation': '待实机', verified: '已验证',
  unsupported: '未配置', invalid: '配置无效',
}
const capabilitySummary = computed(() => {
  const report = props.report
  const unavailable = report.items.filter(item => item.status === 'unsupported' || item.status === 'invalid').length
  const pending = report.items.filter(item => item.status === 'detected' || item.status === 'needs-confirmation').length
  if (report.status === 'invalid') return '模型能力配置无效'
  if (unavailable || pending) {
    const parts = [unavailable ? `${unavailable} 项未配置` : '', pending ? `${pending} 项待实机` : ''].filter(Boolean)
    return `模型能力 · ${parts.join(' · ')}`
  }
  return '模型能力 · 已验证'
})
</script>

<template>
  <details class="live2d-capability-report">
    <StudioDisclosureSummary>{{ capabilitySummary }}</StudioDisclosureSummary>
    <ul>
      <li v-for="item in report.items" :key="item.id" :data-state="item.status">
        <span>{{ capabilityLabels[item.id] }}</span>
        <strong>{{ capabilityStatusLabels[item.status] }}</strong>
        <small>{{ item.reason }}</small>
      </li>
    </ul>
  </details>
</template>

<style scoped>
@reference "../assets/css/tailwind.css";
.live2d-capability-report { @apply tw:mt-s-2 tw:text-secondary; font-size:var(--fs-label-xs); }
.live2d-capability-report summary { @apply tw:min-h-[32px] tw:cursor-pointer tw:text-primary; }
.live2d-capability-report ul { @apply tw:grid tw:gap-[6px]; margin: 6px 0 0; @apply tw:p-0; list-style: none; }
.live2d-capability-report li { @apply tw:grid; grid-template-columns: minmax(4em, auto) auto; gap: 2px 8px; }
.live2d-capability-report strong { @apply tw:text-primary; font-weight: 650; }
.live2d-capability-report small { grid-column: 1 / -1; @apply tw:text-secondary; overflow-wrap: anywhere; }
</style>
