<template>
  <section class="runtime-result">
    <div class="result-toolbar">
      <StudioSelect v-if="task.resultRefs.length > 1" label="选择任务结果" size="sm" inline :model-value="index" :options="resultOptions" @update:model-value="index = Number($event)" />
      <button v-if="selected?.mime.startsWith('image/')" class="btn btn-primary" :disabled="busy || task.deliveryState === 'saved'" @click="save">{{ task.deliveryState === 'saved' ? '已入册' : busy ? '保存中…' : '保存到作品册' }}</button>
      <button class="btn btn-ghost" :disabled="!url && !selected?.mime.startsWith('video/')" @click="download">下载结果</button>
    </div>
    <p v-if="message" role="status">{{ message }}</p>
    <p v-if="loading" role="status">正在读取已保存的结果…</p>
    <img v-else-if="url && selected?.mime.startsWith('image/')" :src="url" alt="生成结果" />
    <StudioMediaPlayer v-else-if="selected?.mime.startsWith('video/') && local" :src="runtimeResultPath(task, index)" label="生成的视频结果" kind="video" />
  </section>
</template>
<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { fetchRuntimeResult, markRuntimeTask, runtimeResultPath, downloadTaskMedia, type TaskRecord } from '@/api/runtimeTasks'
import StudioMediaPlayer from '@/components/ui/StudioMediaPlayer.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import { archiveTaskResult } from '@/composables/tasks/taskArtwork'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'
const props = defineProps<{ task: TaskRecord }>()
const local = isLocalStudioHost()
const index = ref(props.task.resultRefs[0]?.index || 0), url = ref(''), message = ref(''), loading = ref(false), busy = ref(false)
const selected = computed(() => props.task.resultRefs.find(output => output.index === index.value))
const resultOptions = computed(() => props.task.resultRefs.map(output => ({ value: output.index, label: `${output.index + 1} · ${output.mime.startsWith('video/') ? '视频' : '图片'}` })))
let controller: AbortController | undefined
function release() { if (url.value) URL.revokeObjectURL(url.value); url.value = '' }
watch(() => [props.task.taskId, index.value], async () => {
  controller?.abort(); controller = new AbortController(); const signal = controller.signal
  release(); message.value = ''; loading.value = true
  try {
    if (!isLocalStudioHost()) throw new Error('私人生成结果只能在本机工作区查看。')
    if (selected.value?.mime.startsWith('video/')) return
    const blob = await fetchRuntimeResult(runtimeResultPath(props.task, index.value), signal)
    if (!signal.aborted) { url.value = URL.createObjectURL(blob); if (props.task.deliveryState === 'unseen') void markRuntimeTask(props.task.taskId, 'seen').catch(() => {}) }
  } catch (error) { if (!signal.aborted) message.value = error instanceof Error ? error.message : '结果读取失败' }
  finally { if (!signal.aborted) loading.value = false }
}, { immediate: true })
async function save() { busy.value = true; try { await archiveTaskResult(props.task.taskId, index.value); message.value = '已保存到作品册。' } catch (error) { message.value = error instanceof Error ? error.message : '保存尚未确认，请重试同一结果。' } finally { busy.value = false } }
function download() {
  const filename = `绘遇-${props.task.taskId}-${index.value}.${selected.value?.mime.startsWith('video/') ? 'mp4' : 'png'}`
  if (selected.value?.mime.startsWith('video/')) { void downloadTaskMedia(runtimeResultPath(props.task, index.value), filename).catch(error => { message.value = error.message }); return }
  const anchor = document.createElement('a'); anchor.href = url.value; anchor.download = filename; anchor.click()
}
onUnmounted(() => { controller?.abort(); release() })
</script>
<style scoped>
.runtime-result { display: grid; gap: var(--s-3); margin-top: var(--s-3); }
.result-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2); }
.runtime-result img, .runtime-result video { width: 100%; max-height: 460px; object-fit: contain; border-radius: var(--r-lg); background: var(--bg-surface); }
.runtime-result p, .runtime-result label { color: var(--text-secondary); font-size: var(--fs-label); }
.runtime-result :disabled { color: var(--text-disabled); }
</style>
