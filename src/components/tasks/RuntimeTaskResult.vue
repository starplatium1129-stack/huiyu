<template>
  <section class="runtime-result tw:grid tw:gap-s-3 tw:mt-s-3" aria-label="任务结果">
    <div class="result-toolbar tw:flex tw:flex-wrap tw:items-center tw:gap-s-2" data-fluid-glass>
      <StudioSelect v-if="task.resultRefs.length > 1" label="选择任务结果" size="sm" inline :model-value="index" :options="resultOptions" @update:model-value="index = Number($event)" />
      <button v-if="selected?.mime.startsWith('image/')" class="btn btn-primary" :disabled="busy || selectedSaved || manga && task.resultState !== 'available'" @click="save">{{ selectedSaved ? '已入册' : busy ? '保存中…' : '保存到作品册' }}</button>
      <TaskMediaDownload v-if="selected?.mime.startsWith('video/')" class="btn btn-ghost" :src="runtimeResultPath(task, index)" :filename="`绘遇-${task.taskId}-${index}.mp4`">下载结果</TaskMediaDownload>
      <button v-else class="btn btn-ghost" :disabled="loading || readFailed || !url" @click="download">下载结果</button>
    </div>
    <p v-if="manga">{{ task.kind === 'lineart' || index === 1 ? '线稿 · 黑线白底' : '漫画成片' }} · 待主力机验证。{{ task.kind === 'manga' && task.resultRefs.length > 1 ? '漫画与线稿分别入册；全部保存后移出收件箱。' : '' }}</p>
    <p v-if="message" role="status">{{ message }}</p>
    <div ref="preview" class="runtime-result-preview" tabindex="-1" role="region" aria-label="结果预览" :aria-busy="loading">
    <div v-if="selected?.mime.startsWith('image/')" class="runtime-result-image">
      <img v-if="url" :src="url" :alt="loading || readFailed ? '上次读取的生成结果' : '生成结果'" @error="imageFailed" />
      <span v-else>{{ readFailed ? '所选画面暂未读取' : '正在准备画面…' }}</span>
      <span v-if="loading" class="runtime-result-loading" role="status">{{ url ? '正在展开所选结果，上次预览已保留…' : '正在读取已保存的结果…' }}</span>
    </div>
    <StudioMediaPlayer v-else-if="selected?.mime.startsWith('video/') && local" :src="runtimeResultPath(task, index)" label="生成的视频结果" kind="video" />
    <p v-if="readFailed" role="status">{{ url ? '保留了上次读取的画面。' : '可以重新读取这个结果。' }}<button class="btn btn-ghost" type="button" @click="retryRead">重新读取结果</button></p>
    </div>
  </section>
</template>
<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { fetchRuntimeResult, markRuntimeTask, runtimeResultPath, type TaskRecord } from '@/api/runtimeTasks'
import TaskMediaDownload from './TaskMediaDownload.vue'
import StudioMediaPlayer from '@/components/ui/StudioMediaPlayer.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import { abortableTask } from '@/utils/abortableTask'
import { archiveTaskResult } from '@/composables/tasks/taskArtwork'
import { taskArtworkId } from '@/application/artwork/taskResultIdentity'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'
import { artworkRepository } from '@/storage/artworkRepository'
const props = defineProps<{ task: TaskRecord }>()
const local = isLocalStudioHost()
const index = ref(props.task.resultRefs[0]?.index || 0), url = ref(''), message = ref(''), loading = ref(false), busy = ref(false)
const preview = ref<HTMLElement | null>(null), retry = ref(0), readFailed = ref(false)
const manga = computed(() => props.task.kind === 'manga' || props.task.kind === 'lineart')
const savedIndices = ref<number[]>([])
const selectedSaved = computed(() => props.task.deliveryState === 'saved' || savedIndices.value.includes(index.value))
function retryRead(event: MouseEvent) { if (document.activeElement === event.currentTarget) preview.value?.focus({ preventScroll: true }); retry.value++ }
function imageFailed() { if (!loading.value) { readFailed.value = true; message.value = '结果图片暂时无法展开，请重新读取。' } }
const selected = computed(() => props.task.resultRefs.find(output => output.index === index.value))
const resultOptions = computed(() => props.task.resultRefs.map(output => ({ value: output.index,
  label:manga.value ? output.index === 1 || props.task.kind === 'lineart' ? '线稿 · 黑线白底' : '漫画成片' : `${output.index + 1} · ${output.mime.startsWith('video/') ? '视频' : '图片'}` })))
let controller: AbortController | undefined
function release() { if (url.value) URL.revokeObjectURL(url.value); url.value = '' }
// Metadata revisions keep the decoded preview; changed media credentials still reread it.
watch([() => props.task.taskId, () => props.task.workspaceId, () => props.task.principalId, () => props.task.runtimeEpoch,
  index, retry, () => props.task.resultState,
  () => selected.value?.alias, () => selected.value?.sha256, () => selected.value?.bytes, () => selected.value?.mime], async (next, previous) => {
  controller?.abort(); controller = new AbortController(); const signal = controller.signal
  const sessionChanged = next[0] !== previous?.[0] || next[1] !== previous?.[1] || next[2] !== previous?.[2] || next[3] !== previous?.[3]
  if (sessionChanged || !selected.value?.mime.startsWith('image/')) release()
  if (sessionChanged) savedIndices.value = []
  message.value = ''; readFailed.value = false; loading.value = true
  let candidateUrl = ''
  const image = new Image()
  const abortImage = () => image.removeAttribute('src')
  signal.addEventListener('abort', abortImage, { once: true })
  try {
    if (!isLocalStudioHost()) throw new Error('私人生成结果只能在本机工作区查看。')
    if (selected.value?.mime.startsWith('video/')) return
    const task = props.task, outputIndex = index.value
    const blob = await fetchRuntimeResult(runtimeResultPath(task, outputIndex), signal, task)
    signal.throwIfAborted()
    candidateUrl = URL.createObjectURL(blob); image.src = candidateUrl
    // Publish only paintable pixels; the previous image owns the frame until this request is ready.
    await abortableTask(() => image.decode(), signal)
    signal.throwIfAborted()
    release(); url.value = candidateUrl; candidateUrl = ''
    if (manga.value) {
      const saved = await artworkRepository.readArtwork(taskArtworkId(task.taskId, outputIndex))
      signal.throwIfAborted()
      if (saved?.image_id === selected.value?.alias && !savedIndices.value.includes(outputIndex)) savedIndices.value.push(outputIndex)
    }
    if (props.task.deliveryState === 'unseen') void markRuntimeTask(props.task.taskId, 'seen').catch(() => {})
  } catch (error) { if (!signal.aborted) { readFailed.value = true; message.value = error instanceof Error ? error.message : '结果读取失败' } }
  finally { signal.removeEventListener('abort', abortImage); abortImage(); if (candidateUrl) URL.revokeObjectURL(candidateUrl); if (!signal.aborted) loading.value = false }
}, { immediate: true })
async function save() {
  const taskId = props.task.taskId, outputIndex = index.value, signal = controller?.signal
  const current = () => !signal?.aborted && props.task.taskId === taskId && index.value === outputIndex
  busy.value = true
  try {
    await archiveTaskResult(taskId, outputIndex)
    if (current()) { savedIndices.value.push(outputIndex); message.value = '已保存到作品册。' }
  } catch (error) {
    if (current()) message.value = error instanceof Error ? error.message : '保存尚未确认，请重试同一结果。'
  } finally { busy.value = false }
}
function download() {
  if (loading.value || readFailed.value || !url.value) return
  const filename = `绘遇-${props.task.taskId}-${index.value}.png`
  const anchor = document.createElement('a'); anchor.href = url.value; anchor.download = filename; anchor.click()
}
onUnmounted(() => { controller?.abort(); release() })
</script>
<style scoped>
@reference "../../assets/css/tailwind.css";
.runtime-result-preview { min-width:0; }
.runtime-result-preview:focus-visible { outline:none; border-radius:var(--r-md); box-shadow:var(--focus-shadow); }
.runtime-result-image { display:grid; grid-template:minmax(0,1fr)/minmax(0,1fr); place-items:center; height:clamp(180px,36vh,460px); overflow:hidden; border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--art-stage); }
.runtime-result-image>* { grid-area:1/1; }
.runtime-result-image img { width:100%; height:100%; min-height:0; object-fit:contain; }
.runtime-result-image>span { padding:var(--s-4); color:var(--on-art-primary); font-size:var(--fs-label); text-align:center; }
.runtime-result-image>.runtime-result-loading { align-self:end; width:100%; background:var(--bg-surface); color:var(--text-secondary); }
.runtime-result p, .runtime-result label { @apply tw:text-secondary tw:text-label; }
.runtime-result :disabled { @apply tw:text-disabled; }
.runtime-result { padding-top:var(--s-3); border-top:1px solid var(--border-soft); }
.runtime-result .result-toolbar { gap:var(--s-2); }
@media (forced-colors:active) { .runtime-result-preview:focus-visible { outline:2px solid Highlight; box-shadow:none; } }
</style>
