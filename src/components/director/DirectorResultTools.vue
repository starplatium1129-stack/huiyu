<template>
  <div ref="actions" class="result-image-actions" role="group" aria-label="画布操作">
    <span v-if="hasResult && generationBusy" class="stage-result-status sr-only" role="status">下一张正在显影 · 当前成片保留</span>
    <span v-if="hasResult && resultArchived !== null" class="stage-archive-badge" :data-archived="resultArchived" :data-saving="savingResult || undefined" role="status" aria-live="polite" aria-atomic="true">
      <ArchiveIcon :name="resultArchived ? 'success' : 'gallery'" />
      <span>{{ savingResult ? '正在入册…' : resultArchived ? '已入册' : resultTemporary ? '未入册 · 已暂存' : '未入册' }}</span>
    </span>
    <RouterLink v-if="hasResult && resultArchived" class="btn btn-quiet result-archive-action" to="/gallery"><span v-content-motion:up="archivePhase" class="archive-action-content"><ArchiveIcon name="gallery" /><span>查看作品册</span></span></RouterLink>
    <button v-else class="btn btn-ghost result-archive-action" type="button" :disabled="savingResult || !hasResult" :aria-busy="savingResult" @click="requestSave"><span v-content-motion:up="archivePhase" class="archive-action-content"><ArchiveIcon :name="savingResult ? 'refresh' : 'gallery'" /><span>{{ savingResult ? '正在入册…' : '存入作品册' }}</span></span></button>
    <component :is="placeholder ? 'span' : StudioTooltip" :class="{ 'result-action-placeholder': placeholder }" v-bind="placeholder ? {} : { anchor: true, content: canSaveScene === false ? '当前引擎暂不支持将配方存为场景，可先存入作品册' : '将当前成片保存为场景' }">
      <button class="btn btn-quiet canvas-secondary-action" type="button" :aria-label="capturingScene ? '正在读取成片…' : '保存为场景'" :disabled="!hasResult || generationBusy || capturingScene || canSaveScene === false" @click="$emit('saveScene')"><ArchiveIcon name="scene" /><span>{{ capturingScene ? '正在读取成片…' : '保存为场景' }}</span></button>
    </component>
    <component :is="placeholder ? 'span' : StudioTooltip" :class="{ 'result-action-placeholder': placeholder }" v-bind="placeholder ? {} : { anchor: true, content: hasPrevResult ? '与上一张对比' : '尚无上一张成片可供对比' }">
      <button class="btn btn-quiet canvas-secondary-action" type="button" aria-label="与上一张对比" :disabled="!hasResult || !hasPrevResult" @click="$emit('openCompare')"><ArchiveIcon name="compare" /><span>与上一张对比</span></button>
    </component>
    <button class="btn btn-quiet canvas-clear-action" type="button" :disabled="!hasResult" @click="$emit('clearResult')"><ArchiveIcon name="close" />清除图片</button>
  </div>
</template>

<script setup lang="ts">
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { RouterLink } from 'vue-router'
import { computed, defineAsyncComponent, nextTick, ref, watch } from 'vue'
import { contentMotion as vContentMotion } from '@/directives/contentMotion'

// The inert canvas placeholder keeps its geometry without loading tooltip behavior.
const StudioTooltip = defineAsyncComponent(() => import('@/components/ui/StudioTooltip.vue'))
const props = withDefaults(defineProps<{
  placeholder?: boolean
  generationBusy: boolean
  hasPrevResult: boolean
  resultArchived?: boolean | null
  capturingScene?: boolean
  canSaveScene?: boolean
  savingResult?: boolean
  resultTemporary?: boolean
  hasResult?: boolean
}>(), { hasResult: true })
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
  saveScene: []
  saveResult: []
  openCompare: []
  clearResult: []
}>()
</script>

<style scoped>
.result-action-placeholder { display:inline-flex; align-items:center; min-width:0; max-width:100%; }
.result-archive-action { min-inline-size:calc(5em + var(--s-8) + var(--s-5)); justify-content:center; }
.archive-action-content { display:inline-flex; align-items:center; justify-content:center; gap:var(--s-2); white-space:nowrap; }
</style>
