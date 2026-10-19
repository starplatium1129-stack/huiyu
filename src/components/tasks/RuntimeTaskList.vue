<template>
  <section class="runtime-task-list tw:flex tw:flex-col tw:gap-s-3 tw:min-h-0" aria-label="工作区任务和结果收件箱">
    <div class="runtime-task-controls tw:flex tw:flex-wrap tw:items-center tw:gap-s-2"><div class="studio-segments studio-segments--compact" data-fluid-glass role="group" aria-label="工作区任务筛选"><AnimatedSelection /><button v-for="filter in filters" :key="filter.id" class="btn btn-ghost" :aria-pressed="selected === filter.id" @click="selected = filter.id">{{ filter.label }}</button></div><button class="btn btn-ghost" :disabled="!!busy" :aria-busy="busy === 'refresh'" @click="refresh">{{ busy === 'refresh' ? '查询中…' : '更新状态' }}</button></div>
    <p class="inbox-explanation">切换页面后，已接收任务由本地运行时继续处理。结果先保存在收件箱，入册设置保持不变。</p>
    <p v-if="runtimeTaskError || feedback || historyError" role="status">{{ feedback || historyError || runtimeTaskError }}</p>
    <p v-if="historyLoading" role="status">正在读取任务历史…</p>
    <div v-content-motion="selected" class="runtime-task-items tw:grid tw:gap-s-3 tw:min-h-0">
    <article v-for="pending in pendingTaskRequests" :key="pending.key" class="runtime-task tw:p-s-4 tw:rounded-lg"><strong>提交结果待确认</strong><p>保留了这次操作的编号；查询不会重新生成。</p><button class="btn btn-ghost" :disabled="!!busy" :aria-busy="busy === 'refresh'" @click="refresh">{{ busy === 'refresh' ? '查询中…' : '查询接收状态' }}</button><button class="btn btn-ghost" :disabled="!canCancelKey(pending.key)" :aria-busy="cancellingKey === pending.key" @click="cancelKey(pending.key)">{{ cancellingKey === pending.key ? '正在取消…' : '取消这次提交' }}</button></article>
    <article v-for="task in visible" :key="task.taskId" :id="cardId(task.taskId)" tabindex="-1" class="runtime-task tw:p-s-4 tw:rounded-lg" :data-state="task.status" :data-attention="task.recoveryState !== 'normal' || undefined">
      <header><strong>{{ titles[task.kind] }}{{ locatedId === task.taskId ? ' · 已定位' : '' }}</strong><span>{{ task.recoveryState !== 'normal' ? '待核对' : labels[task.status] }}</span></header>
      <p>{{ taskMessage(task) }}</p><p v-if="task.kind === 'manga' || task.kind === 'lineart'">待主力机验证</p><time :datetime="new Date(task.createdAt).toISOString()">{{ taskDateFormatter.format(task.createdAt) }}</time>
      <div class="runtime-actions tw:mt-s-3">
        <RouterLink class="btn btn-ghost" :to="routeFor(task)" @click="emit('navigate')">{{ task.kind === 'manga' || task.kind === 'lineart' ? '前往我的作品' : '返回工作台' }}</RouterLink>
        <button v-if="task.resultRefs.length && task.deliveryState !== 'discarded'" class="btn btn-primary" :aria-expanded="active && expanded === task.taskId" :aria-controls="`${resultRegionId}-${task.taskId}`" @click="expanded = expanded === task.taskId ? '' : task.taskId">{{ expanded === task.taskId ? '收起结果' : '查看结果' }}</button>
        <button v-if="!task.upstreamSettled" class="btn btn-ghost" :disabled="!!busy" @click="act(task, 'cancel')">取消任务</button>
        <button v-if="task.deliveryState !== 'discarded' && task.errorCode !== 'WEBUI_STOP_CONFIRMED' && (task.recoveryState !== 'normal' || task.resultState === 'unavailable')" class="btn btn-ghost" :disabled="!!busy" @click="act(task, 'reconcile')">重新核对</button>
        <button v-if="task.kind === 'generation' && task.provider === 'webui' && task.recoveryState === 'unknown' && task.submissionIntentAt && !task.upstreamSettled" class="btn btn-ghost" :disabled="!!busy" @click="act(task, 'resolve-webui')">解除 WebUI 占用</button>
        <button v-if="task.status === 'queued' && !task.submissionIntentAt" class="btn btn-ghost" :disabled="!!busy || !!task.cancelRequestedAt" @click="act(task, 'resume')">{{ task.kind === 'manga' || task.kind === 'lineart' ? '继续处理' : '继续生成' }}</button>
        <button v-if="task.retryTaskId" class="btn btn-ghost" :disabled="!!busy" :aria-busy="busy === `locate:${task.retryTaskId}`" @click="openRelated(task.retryTaskId)">{{ busy === `locate:${task.retryTaskId}` ? '正在定位…' : '查看重试任务' }}</button>
        <button v-else-if="canRetry(task)" class="btn btn-primary" :disabled="!!busy || pendingRetry(task)" :aria-busy="busy === `retry:${task.taskId}`" @click="retry(task)">{{ busy === `retry:${task.taskId}` ? '正在准备重试…' : pendingRetry(task) ? '重试接收待确认' : '重试此任务' }}</button>
        <button v-if="task.retryOfTaskId" class="btn btn-ghost" :disabled="!!busy" :aria-busy="busy === `locate:${task.retryOfTaskId}`" @click="openRelated(task.retryOfTaskId)">{{ busy === `locate:${task.retryOfTaskId}` ? '正在定位…' : '查看原任务' }}</button>
        <button v-if="task.errorCode === 'BATCH_AWAITING_EXPLICIT_CONTINUE'" class="btn btn-ghost" :disabled="!!busy" @click="act(task, 'continue')">继续剩余分镜</button>
        <button v-if="task.canConcat" class="btn btn-ghost" :disabled="!!busy" @click="act(task, 'concat')">拼接成片</button>
        <button v-if="task.upstreamSettled && task.resultState === 'available'" class="btn btn-ghost" :disabled="!!busy" @click="discarding = task.taskId">移出收件箱</button>
      </div>
      <p v-if="canRetry(task) && !task.retryTaskId">重试会沿用已保存的原图和参数，从头处理；原任务与已有结果保留。</p>
      <p v-if="discarding === task.taskId">已入册作品会保留；未入册结果将从收件箱移除。<button class="btn btn-ghost" :disabled="!!busy" @click="act(task, 'discard')">确认移出</button><button class="btn btn-ghost" @click="discarding = ''">保留结果</button></p>
      <div v-if="task.resultRefs.length && task.deliveryState !== 'discarded'" :id="`${resultRegionId}-${task.taskId}`" :hidden="!active || expanded !== task.taskId">
        <RuntimeTaskPreview v-if="active && expanded === task.taskId" :task-id="task.taskId" :revision="task.revision" />
      </div>
    </article>
    <p v-if="!visible.length" class="runtime-empty">{{ selected === 'inbox' ? '暂时没有未入册结果。' : '这里会保留已接收任务和可找回的结果。' }}</p>
    </div>
    <nav class="runtime-actions" aria-label="任务分页">
      <button class="btn btn-ghost" type="button" :disabled="historyLoading || !hasPrevious" @click="previous">上一页</button>
      <span role="status">第 {{ pageNumber }} 页 · 本页 {{ pageCount }} 条{{ locatedId ? ' · 已定位关联任务' : '' }}</span>
      <button class="btn btn-ghost" type="button" :disabled="historyLoading || !hasNext" @click="next">下一页</button>
    </nav>
  </section>
</template>
<script setup lang="ts">
import { ref, useId, watch } from 'vue'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import RuntimeTaskPreview from './RuntimeTaskPreview.vue'
import { refreshRuntimeTasks, getRuntimeTaskByKey, taskMessage, cancelRuntimeTask, cancelRuntimeTaskKey, actOnRuntimeTask, confirmWebuiTaskStopped, markRuntimeTask, type TaskSummary } from '@/api/runtimeTasks'
import { runtimeTaskError, pendingTaskRequests } from '@/stores/runtimeTaskState'
import { useRuntimeTaskBrowser } from '@/composables/tasks/useRuntimeTaskBrowser'
import { useMangaTaskRetry } from '@/composables/tasks/useMangaTaskRetry'
import { confirmAction } from '@/composables/useConfirm'
import { runtimeTaskOpenRequest } from '@/composables/useTaskCenter'
const props = defineProps<{ active: boolean }>()
const emit = defineEmits<{ navigate: [] }>()
const resultRegionId = useId()
const cardId = (id: string) => `${resultRegionId}-${id}-card`
const expanded = ref(''), busy = ref(''), feedback = ref(''), discarding = ref('')
const cancellingKey = ref('')
const canCancelKey = (key: string) => !cancellingKey.value && (!busy.value || key.startsWith('manga-retry:') && busy.value === `retry:${key.slice('manga-retry:'.length)}`)
const { selected, visible, locatedId, pageCount, loading: historyLoading, error: historyError, pageNumber, hasPrevious, hasNext,
  refresh: refreshHistory, next, previous, reveal } = useRuntimeTaskBrowser(() => props.active)
const { canRetry, pendingRetry, retry, openRelated } = useMangaTaskRetry({ busy, feedback, active: () => props.active, reveal, cardId })
let openedRequest = 0
watch([() => props.active, runtimeTaskOpenRequest], ([active, request]) => {
  if (!active || request === openedRequest) return
  openedRequest = request
  // Entry actions reveal the newest tasks even if the inbox kept an older page.
  if (selected.value !== 'all') selected.value = 'all'
  else void refreshHistory()
}, {immediate:true})
const filters = [{ id: 'all', label: '全部任务' }, { id: 'active', label: '进行中' }, { id: 'attention', label: '待处理' }, { id: 'inbox', label: '结果收件箱' }] as const
const titles = { generation: 'WAI 绘图', anima: 'Anima 绘图', creative: 'Krea 2 绘图', qwen: 'Qwen 图像创作', manga: '漫画化', lineart: '独立线稿', video: '视频创作', batch: '分镜短片' }
const labels = { queued: '已接收', submitting: '提交中', running: '生成中', cancelling: '取消中', succeeded: '已完成', failed: '未完成', cancelled: '已取消' }
const taskDateFormatter = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
const routeFor = (task: TaskSummary) => task.kind === 'qwen' ? '/qwen-studio?job=' + encodeURIComponent(task.taskId) : task.kind === 'manga' || task.kind === 'lineart' ? '/gallery' : task.kind === 'video' ? `/video-studio?job=${task.taskId}` : task.kind === 'batch' ? `/video-studio?mode=shots&batch=${encodeURIComponent(task.sourceBatchId || task.taskId)}` : '/prompt-builder'
async function refresh() {
  if (busy.value) return
  busy.value = 'refresh'; feedback.value = ''
  try {
    // Explicit queries also find accepted retries outside the overview window.
    await Promise.all(pendingTaskRequests.value.map(request => getRuntimeTaskByKey(request.key)))
    await Promise.all([refreshRuntimeTasks(), refreshHistory()])
  } catch (error) { feedback.value = error instanceof Error ? error.message : '任务状态暂时无法读取。' }
  finally { busy.value = '' }
}
async function cancelKey(key: string) {
  if (!canCancelKey(key)) return
  // Cancel intent can be recorded while retry input restoration is still busy.
  const ownsBusy = !busy.value
  if (ownsBusy) busy.value = key
  cancellingKey.value = key; feedback.value = ''
  try { await cancelRuntimeTaskKey(key); feedback.value = '取消意图已记录。' }
  catch { feedback.value = '取消尚未确认，请保持原操作并重试查询。' }
  finally { cancellingKey.value = ''; if (ownsBusy) busy.value = '' }
}
async function act(task: TaskSummary, action: 'cancel' | 'reconcile' | 'resume' | 'continue' | 'concat' | 'discard' | 'resolve-webui') {
  if (busy.value) return
  feedback.value = ''
  if (action === 'resolve-webui' && !await confirmAction({ title: '确认 WebUI 已停止', message: '请先在 WebUI 中停止该任务，或完成 WebUI 服务重启。确认后将解除这条未知任务的占用，保留原任务和已保存结果；未取回的结果仍未确认。应用不会代你停止 WebUI。', confirmLabel: '我已停止或重启 WebUI', cancelLabel: '暂不解除' })) return
  if (busy.value) return
  busy.value = task.taskId
  try {
    if (action === 'resolve-webui') {
      await confirmWebuiTaskStopped(task.taskId, task.revision)
      feedback.value = '已按你的确认解除占用，可以发起新任务。'
    } else if (action === 'cancel') await cancelRuntimeTask(task.taskId)
    else if (action === 'discard') {
      await markRuntimeTask(task.taskId, 'discarded')
      if (expanded.value === task.taskId) expanded.value = ''
      if (discarding.value === task.taskId) discarding.value = ''
    }
    else await actOnRuntimeTask(task.taskId, action)
  }
  catch (error) { feedback.value = error instanceof Error ? error.message : '操作尚未完成，请重新核对。' }
  finally { busy.value = '' }
}
</script>
<style scoped>
@reference "../../assets/css/tailwind.css";
.runtime-actions { @apply tw:flex tw:flex-wrap tw:gap-s-2; }
.runtime-task-list { flex:1; overflow:hidden; }
.runtime-task-list .runtime-task-controls,.runtime-task-list > p { flex-shrink:0; }
.runtime-task-items { flex:1; overflow-y:auto; overscroll-behavior:contain; scrollbar-width:thin; padding-right:var(--s-1); }
.runtime-task { border:0; background:var(--bg-base); }
.runtime-task header { @apply tw:flex tw:justify-between tw:gap-s-3; }
.runtime-task p, .runtime-task time, .runtime-task span, .inbox-explanation, .runtime-empty { @apply tw:text-secondary tw:text-label tw:leading-body; }
.runtime-task p { margin: var(--s-2) 0; }
.runtime-task header strong { font-size:var(--fs-body-sm); font-weight:600; }
.runtime-task header span { padding:var(--s-1) var(--s-2); border-radius:var(--r-pill); background:var(--bg-elevated); white-space:nowrap; }
.runtime-task[data-attention] header span,.runtime-task[data-state='failed'] header span { color:var(--warning-text); }
.runtime-task[data-state='succeeded']:not([data-attention]) header span { color:var(--success-text); }
.runtime-task time { display:block; margin-top:var(--s-3); font-size:var(--fs-label-xs); }
.runtime-task .runtime-actions { gap:var(--s-2); padding-top:var(--s-3); border-top:1px solid var(--border-soft); }
.runtime-task-list :disabled { @apply tw:text-disabled; }
</style>
