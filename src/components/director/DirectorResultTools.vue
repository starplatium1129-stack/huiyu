<template>
  <div ref="actions" class="result-image-actions">
    <span v-if="resultArchived !== null" v-content-motion="archivePhase" class="stage-archive-badge" :data-archived="resultArchived" :data-saving="savingResult || undefined" role="status" aria-live="polite" aria-atomic="true">
      <ArchiveIcon :name="resultArchived ? 'success' : 'gallery'" />
      <span>{{ savingResult ? '正在存入作品册…' : resultArchived ? '已入册' : resultTemporary ? '未入册 · 已暂存' : '未入册 · 请保存画面' }}</span>
    </span>
    <RouterLink v-if="resultArchived" class="btn btn-primary result-archive-action" to="/gallery"><ArchiveIcon name="gallery" />查看作品册</RouterLink>
    <button v-else class="btn btn-primary result-archive-action" type="button" :disabled="savingResult" :aria-busy="savingResult" @click="requestSave"><ArchiveIcon name="gallery" />{{ savingResult ? '正在入册…' : '存入作品册' }}</button>
    <button class="btn btn-ghost" type="button" :disabled="generationBusy || capturingScene" @click="$emit('saveScene')">
      <ArchiveIcon name="gallery" />{{ capturingScene ? '正在读取成片…' : '保存为场景' }}
    </button>
    <button class="btn btn-ghost" type="button" :disabled="!hasPrevResult" @click="$emit('openCompare')">与上一张对比</button>
  </div>
</template>

<script setup lang="ts">
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { RouterLink } from 'vue-router'
import { computed, nextTick, ref, watch } from 'vue'
import { contentMotion as vContentMotion } from '@/directives/contentMotion'

const props = defineProps<{
  generationBusy: boolean
  hasPrevResult: boolean
  resultArchived?: boolean | null
  capturingScene?: boolean
  savingResult?: boolean
  resultTemporary?: boolean
}>()
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
}>()
</script>
