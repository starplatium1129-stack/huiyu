<template>
  <section ref="root" class="chat-drawing-batch" aria-label="出图卡">
    <header class="drawing-heading">
      <strong><ArchiveIcon name="palette" />{{ batch?.state === 'draft' ? '出图方案' : '对话出图' }}</strong>
      <span class="drawing-status" role="status">{{ status }}</span>
    </header>
    <div v-if="error" class="drawing-error" role="alert">
      <span>{{ error }}</span>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="busy" @click="reload">刷新出图卡</button>
    </div>
    <template v-if="batch">
      <progress v-if="active && batch.jobs.length" :value="processed" :max="batch.jobs.length" aria-label="批次处理进度" />
      <ul v-if="batch.jobs.length" class="drawing-items">
        <li v-for="(job, index) in batch.jobs" :key="job.id" class="drawing-item">
          <div class="drawing-item-summary">
            <div class="drawing-item-copy">
              <span>{{ index + 1 }}. {{ job.sceneTitle }}</span>
              <small v-if="job.modelId || (job.width && job.height) || job.seed !== undefined" class="drawing-meta">
                {{ [job.modelId, job.width && job.height ? `${job.width} × ${job.height}` : null, job.seed !== undefined ? `种子 ${job.seed}` : null].filter(Boolean).join(' · ') }}
              </small>
            </div>
            <small class="drawing-item-status" :class="{ 'is-failed': job.status === 'failed' }">
              {{ batch.state === 'draft' ? '待开始' : jobStatus[job.status] }}
            </small>
          </div>
          <div v-if="job.error" class="drawing-error">{{ job.error }}</div>
          <div v-if="canEdit(job)" class="drawing-actions">
            <button v-if="editor?.index !== index" class="btn btn-ghost btn-sm" type="button" :disabled="busy"
              :aria-label="`调整第 ${index + 1} 张的提示词`" @click="openEditor(index)">调整提示词</button>
            <button v-if="canRerun(job) && editor?.index !== index" class="btn btn-secondary btn-sm" type="button" :disabled="busy"
              :aria-label="`${job.status === 'succeeded' ? '重绘' : '重试'}第 ${index + 1} 张`" @click="update(index, 'rerun')">
              {{ job.status === 'succeeded' ? '重绘这张' : '重试这张' }}
            </button>
          </div>
          <form v-if="editor?.index === index" class="drawing-editor" @submit.prevent="saveItem(index)">
            <label :for="promptId">第 {{ index + 1 }} 张的提示词</label>
            <textarea :id="promptId" ref="promptField" v-model="prompt" class="input" rows="4" :disabled="busy" required />
            <div class="drawing-actions">
              <button class="btn btn-primary btn-sm" type="submit" :disabled="busy || !prompt.trim()">
                {{ batch.state === 'draft' ? '保存修改' : '按修改重绘' }}
              </button>
              <button class="btn btn-ghost btn-sm" type="button" :disabled="busy" @click="closeEditor">取消编辑</button>
            </div>
          </form>
        </li>
      </ul>
      <div v-if="batch.error" class="drawing-error">{{ batch.error }}</div>
      <div v-if="batch.state === 'draft' || batch.state === 'running' || batch.state === 'paused'" class="drawing-actions drawing-controls">
        <button v-if="batch.state !== 'running'" class="btn btn-primary btn-sm" type="button"
          :disabled="busy || editor !== null" @click="control('PATCH')">
          {{ batch.state === 'draft' ? '开始绘图' : '继续绘图' }}
        </button>
        <button v-if="batch.state !== 'draft'" class="btn btn-ghost btn-sm" type="button"
          :disabled="busy" @click="control('DELETE')">停止这批</button>
      </div>
    </template>
    <CompanionChatImages v-if="shownImages.length" :images="shownImages" />
  </section>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, ref, useId } from 'vue'
import type { CompanionBatchJob } from '@/api/companionDrawingApi'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { drawingBatchActive, useCompanionDrawingCard } from '@/composables/chat/useCompanionDrawingCard'
import { parseCompanionChatImages, type CompanionChatImage } from '@/types/companionDrawing'

const CompanionChatImages = defineAsyncComponent(() => import('./CompanionChatImages.vue'))
const props = defineProps<{ batchId: string; savedImages?: CompanionChatImage[] }>()
const { root, batch, editor, error, busy, loading, reload, control, edit, update } = useCompanionDrawingCard(props.batchId)
const promptId = useId()
const prompt = ref('')
const promptField = ref<HTMLTextAreaElement[]>([])
let editorTrigger: HTMLElement | null = null
const active = computed(() => drawingBatchActive(batch.value))
const jobStatus: Record<string, string> = {
  pending: '排队中', running: '绘制中', accepted: '已提交', unknown: '待核对',
  cancelled: '已停止', failed: '生成失败', succeeded: '已出图',
}
const processed = computed(() => batch.value?.jobs.filter(job => ['succeeded', 'failed', 'cancelled'].includes(job.status)).length ?? 0)
const status = computed(() => {
  const current = batch.value
  if (!current) return loading.value ? '正在读取…' : ''
  if (current.state === 'draft') return `${current.jobs.length} 张待确认`
  if (current.state === 'cancelling') return '正在停止…'
  if (current.state === 'paused') return '已暂停'
  if (current.state === 'cancelled') return '已停止'
  const done = current.jobs.filter(job => job.status === 'succeeded').length
  return active.value ? `已处理 ${processed.value}/${current.jobs.length} 张` : `已完成 ${done}/${current.jobs.length} 张`
})
const shownImages = computed(() => {
  if (!batch.value) return props.savedImages ?? []
  return parseCompanionChatImages(batch.value.jobs.map((job, index) => {
    const result = job.status === 'succeeded' ? job : job.previousResult
    return result?.taskId && {
      path: `/api/tasks/v1/${result.taskId}/results/0`, taskId: result.taskId,
      imageId: result.imageId, artworkId: result.historyId,
      name: `第 ${index + 1} 张 · ${job.sceneTitle}${result === job ? '' : ' · 原图'}`.slice(0, 240),
    }
  }))
})

function canRerun(job: CompanionBatchJob) {
  return batch.value && ['succeeded', 'failed', 'cancelled'].includes(batch.value.state)
    && ['succeeded', 'failed', 'cancelled'].includes(job.status)
}
function canEdit(job: CompanionBatchJob) {
  return batch.value?.state === 'draft' || canRerun(job)
}
async function openEditor(index: number) {
  const trigger = document.activeElement
  if (!await edit(index) || !editor.value) return
  editorTrigger = trigger instanceof HTMLElement ? trigger : null
  prompt.value = editor.value.prompt
  await nextTick()
  promptField.value[0]?.focus()
}
async function saveItem(index: number) {
  const operation = batch.value?.state === 'draft' ? 'edit' : 'rerun'
  if (await update(index, operation, prompt.value)) await restoreFocus()
}
async function restoreFocus() {
  await nextTick()
  if (editorTrigger?.isConnected) editorTrigger.focus()
  else if (document.activeElement === document.body) root.value?.querySelector<HTMLElement>('button:not(:disabled)')?.focus()
  editorTrigger = null
}
function closeEditor() {
  editor.value = null
  void restoreFocus()
}
</script>

<style scoped>
.chat-drawing-batch { display:grid; gap:var(--s-2); min-inline-size:0; margin-block:var(--s-2); padding:var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--bg-surface); color:var(--text-primary); font-size:var(--fs-body-sm); }
.drawing-heading,.drawing-item-summary { display:flex; flex-wrap:wrap; align-items:baseline; justify-content:space-between; gap:var(--s-1) var(--s-2); }
.drawing-heading strong { display:inline-flex; align-items:center; gap:var(--s-2); font-size:var(--fs-label); }
.drawing-heading svg { inline-size:1em; block-size:1em; }
.drawing-status,.drawing-item-status,.drawing-meta { color:var(--text-secondary); font-size:var(--fs-label-xs); font-variant-numeric:tabular-nums; }
.chat-drawing-batch progress { inline-size:100%; }
.drawing-items { display:grid; gap:var(--s-2); padding:0; margin:0; list-style:none; }
.drawing-item { display:grid; gap:var(--s-2); min-inline-size:0; padding-block:var(--s-2); border-block-start:1px solid var(--border-soft); }
.drawing-item-copy { display:grid; gap:var(--s-1); min-inline-size:0; overflow-wrap:anywhere; }
.drawing-error,.drawing-item-status.is-failed { color:var(--danger-text); overflow-wrap:anywhere; }
.drawing-actions { display:flex; flex-wrap:wrap; align-items:center; gap:var(--s-2); }
.drawing-editor { display:grid; gap:var(--s-2); min-inline-size:0; }
.drawing-editor textarea { inline-size:100%; min-inline-size:0; resize:vertical; }
</style>
