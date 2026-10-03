<template>
  <div ref="actions" class="result-image-actions" role="group" aria-label="画布操作">
    <button class="btn btn-ghost canvas-ambient-toggle" type="button" aria-label="作品环境光" :aria-pressed="ambientEnabled" :disabled="!hasResult" @click="$emit('update:ambientEnabled', !ambientEnabled)"><ArchiveIcon name="goldenhour" /><span>环境光</span></button>
    <span v-if="hasResult && generationBusy" class="stage-result-status sr-only" role="status">下一张正在显影 · 当前成片保留</span>
    <span v-if="hasResult && resultArchived !== null" v-content-motion="archivePhase" class="stage-archive-badge" :data-archived="resultArchived" :data-saving="savingResult || undefined" role="status" aria-live="polite" aria-atomic="true">
      <ArchiveIcon :name="resultArchived ? 'success' : 'gallery'" />
      <span>{{ savingResult ? '正在入册…' : resultArchived ? '已入册' : resultTemporary ? '未入册 · 已暂存' : '未入册' }}</span>
    </span>
    <RouterLink v-if="hasResult && resultArchived" class="btn btn-primary result-archive-action" to="/gallery"><ArchiveIcon name="gallery" />查看作品册</RouterLink>
    <button v-else-if="hasResult" class="btn btn-primary result-archive-action" type="button" :disabled="savingResult" :aria-busy="savingResult" @click="requestSave"><ArchiveIcon name="gallery" />{{ savingResult ? '正在入册…' : '存入作品册' }}</button>
    <StudioTooltip v-if="hasResult" anchor content="将当前成片保存为场景">
      <button class="btn btn-ghost canvas-secondary-action" type="button" :aria-label="capturingScene ? '正在读取成片…' : '保存为场景'" :disabled="generationBusy || capturingScene" @click="$emit('saveScene')"><ArchiveIcon name="scene" /><span>{{ capturingScene ? '正在读取成片…' : '保存为场景' }}</span></button>
    </StudioTooltip>
    <StudioTooltip v-if="hasResult" anchor content="与上一张对比">
      <button class="btn btn-ghost canvas-secondary-action" type="button" aria-label="与上一张对比" :disabled="!hasPrevResult" @click="$emit('openCompare')"><ArchiveIcon name="compare" /><span>与上一张对比</span></button>
    </StudioTooltip>
  </div>
</template>

<script setup lang="ts">
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import { RouterLink } from 'vue-router'
import { computed, nextTick, ref, watch } from 'vue'
import { contentMotion as vContentMotion } from '@/directives/contentMotion'

const props = withDefaults(defineProps<{
  generationBusy: boolean
  hasPrevResult: boolean
  resultArchived?: boolean | null
  capturingScene?: boolean
  savingResult?: boolean
  resultTemporary?: boolean
  hasResult?: boolean
  ambientEnabled?: boolean
}>(), { hasResult: true, ambientEnabled: true })
const actions = ref<HTMLElement | null>(null)
let saveHadFocus = false
const archivePhase = computed(() => props.savingResult ? 'saving' : props.resultArchived ? 'saved' : 'pending')
function requestSave() {
  saveHadFocus = !!actions.value?.contains(document.activeElement) && !!document.activeElement?.matches('.result-archive-action')
  emit('saveResult')
}
// Saving replaces the action with a link. Keep keyboard focus on its continuation.
watch(() => props.resultArchived, async (archived, previous) => {
  if (!archived || previous) return
  const shouldFocus = !!actions.value?.contains(document.activeElement) && !!document.activeElement?.matches('.result-archive-action') || saveHadFocus && document.activeElement === document.body
  saveHadFocus = false
  if (!shouldFocus) return
  await nextTick()
  const continuation = actions.value?.querySelector<HTMLElement>('.result-archive-action')
  if (continuation?.isConnected) continuation.focus({ preventScroll:true })
})
const emit = defineEmits<{
  'update:ambientEnabled': [enabled: boolean]
  saveScene: []
  saveResult: []
  openCompare: []
}>()
</script>
