<template>
  <section class="runtime-task-list tw:flex tw:flex-col tw:gap-s-3 tw:min-h-0" aria-label="工作区任务和结果收件箱">
    <nav aria-label="工作区任务筛选"><button v-for="filter in filters" :key="filter.id" class="btn btn-ghost" :aria-pressed="selected === filter.id" @click="selected = filter.id">{{ filter.label }}</button><button class="btn btn-ghost" :disabled="busy === 'refresh'" @click="refresh">更新状态</button></nav>
    <p class="inbox-explanation">切换页面后，已接收任务由本地运行时继续处理。结果先保存在收件箱，入册设置保持不变。</p>
    <p v-if="runtimeTaskError || feedback" role="status">{{ feedback || runtimeTaskError }}</p>
    <div v-content-motion="selected" class="runtime-task-items tw:grid tw:gap-s-3 tw:min-h-0">
    <article v-for="pending in pendingTaskRequests" :key="pending.key" class="runtime-task tw:p-s-4 tw:rounded-lg"><strong>提交结果待确认</strong><p>保留了这次操作的编号；查询不会重新生成。</p><button class="btn btn-ghost" @click="refresh">查询接收状态</button><button class="btn btn-ghost" @click="cancelKey(pending.key)">取消这次提交</button></article>
    <article v-for="task in visible" :key="task.taskId" class="runtime-task tw:p-s-4 tw:rounded-lg" :data-state="task.status" :data-attention="task.recoveryState !== 'normal' || undefined">
      <header><strong>{{ titles[task.kind] }}</strong><span>{{ task.recoveryState !== 'normal' ? '待核对' : labels[task.status] }}</span></header>
      <p>{{ taskMessage(task) }}</p><time :datetime="new Date(task.createdAt).toISOString()">{{ new Date(task.createdAt).toLocaleString('zh-CN') }}</time>
      <div class="runtime-actions tw:mt-s-3">
        <RouterLink class="btn btn-ghost" :to="routeFor(task)" @click="emit('navigate')">返回工作台</RouterLink>
        <button v-if="task.resultRefs.length" class="btn btn-primary" @click="expanded = expanded === task.taskId ? '' : task.taskId">{{ expanded === task.taskId ? '收起结果' : '查看结果' }}</button>
        <button v-if="!task.upstreamSettled" class="btn btn-ghost" :disabled="!!busy" @click="act(task, 'cancel')">取消任务</button>
        <button v-if="task.deliveryState !== 'discarded' && task.errorCode !== 'WEBUI_STOP_CONFIRMED' && (task.recoveryState !== 'normal' || task.resultState === 'unavailable')" class="btn btn-ghost" :disabled="!!busy" @click="act(task, 'reconcile')">重新核对</button>
        <button v-if="task.kind === 'generation' && task.provider === 'webui' && task.recoveryState === 'unknown' && task.submissionIntentAt && !task.upstreamSettled" class="btn btn-ghost" :disabled="!!busy" @click="act(task, 'resolve-webui')">解除 WebUI 占用</button>
        <button v-if="task.status === 'queued' && !task.submissionIntentAt" class="btn btn-ghost" :disabled="!!busy" @click="act(task, 'resume')">继续生成</button>
        <button v-if="task.errorCode === 'BATCH_AWAITING_EXPLICIT_CONTINUE'" class="btn btn-ghost" :disabled="!!busy" @click="act(task, 'continue')">继续剩余分镜</button>
        <button v-if="task.kind === 'batch' && task.status === 'succeeded' && task.resultRefs.length > 1 && !hasConcat(task)" class="btn btn-ghost" :disabled="!!busy" @click="act(task, 'concat')">拼接成片</button>
        <button v-if="task.upstreamSettled && task.resultState === 'available'" class="btn btn-ghost" :disabled="!!busy" @click="discarding = task.taskId">移出收件箱</button>
      </div>
      <p v-if="discarding === task.taskId">已入册作品会保留；未入册结果将从收件箱移除。<button class="btn btn-ghost" :disabled="!!busy" @click="act(task, 'discard')">确认移出</button><button class="btn btn-ghost" @click="discarding = ''">保留结果</button></p>
      <RuntimeTaskResult v-if="expanded === task.taskId && task.resultRefs.length && task.deliveryState !== 'discarded'" :task="task" />
    </article>
    <p v-if="!visible.length" class="runtime-empty">{{ selected === 'inbox' ? '暂时没有未入册结果。' : '这里会保留已接收任务和可找回的结果。' }}</p>
    </div>
  </section>
</template>
<script setup lang="ts">
import { computed, ref } from 'vue'
import RuntimeTaskResult from './RuntimeTaskResult.vue'
import { refreshRuntimeTasks, taskMessage, cancelRuntimeTask, cancelRuntimeTaskKey, actOnRuntimeTask, confirmWebuiTaskStopped, markRuntimeTask, type TaskRecord } from '@/api/runtimeTasks'
import { runtimeTasks, runtimeTaskError, pendingTaskRequests } from '@/stores/runtimeTaskState'
import { confirmAction } from '@/composables/useConfirm'
const emit = defineEmits<{ navigate: [] }>()
const selected = ref('all'), expanded = ref(''), busy = ref(''), feedback = ref(''), discarding = ref('')
const filters = [{ id: 'all', label: '全部任务' }, { id: 'active', label: '进行中' }, { id: 'attention', label: '待处理' }, { id: 'inbox', label: '结果收件箱' }]
const titles = { generation: 'WAI 绘图', anima: 'Anima 绘图', creative: 'Krea 2 绘图', video: '视频创作', batch: '分镜短片' }
const labels = { queued: '已接收', submitting: '提交中', running: '生成中', cancelling: '取消中', succeeded: '已完成', failed: '未完成', cancelled: '已取消' }
const visible = computed(() => runtimeTasks.value.filter(task => selected.value === 'all' || (selected.value === 'active' ? !task.upstreamSettled : selected.value === 'inbox' ? task.resultRefs.length && !['saved', 'discarded'].includes(task.deliveryState) : task.recoveryState !== 'normal' || task.status === 'failed')))
const routeFor = (task: TaskRecord) => task.kind === 'video' ? `/video-studio?job=${task.taskId}` : task.kind === 'batch' ? `/video-studio?mode=shots&batch=${task.taskId}` : '/prompt-builder'
const hasConcat = (task: TaskRecord) => Array.isArray(task.checkpoint?.shots) && task.resultRefs.some(result => result.index === (task.checkpoint!.shots as unknown[]).length)
async function refresh() { busy.value = 'refresh'; feedback.value = ''; try { await refreshRuntimeTasks() } catch {} finally { busy.value = '' } }
async function cancelKey(key: string) { try { await cancelRuntimeTaskKey(key); feedback.value = '取消意图已记录。' } catch { feedback.value = '取消尚未确认，请保持原操作并重试查询。' } }
async function act(task: TaskRecord, action: 'cancel' | 'reconcile' | 'resume' | 'continue' | 'concat' | 'discard' | 'resolve-webui') {
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
    else if (action === 'discard') { await markRuntimeTask(task.taskId, 'discarded'); expanded.value = ''; discarding.value = '' }
    else await actOnRuntimeTask(task.taskId, action)
  }
  catch (error) { feedback.value = error instanceof Error ? error.message : '操作尚未完成，请重新核对。' }
  finally { busy.value = '' }
}
</script>
<style scoped>
@reference "../../assets/css/tailwind.css";
.runtime-task-list nav, .runtime-actions { @apply tw:flex tw:flex-wrap tw:gap-s-2; }
.runtime-task-list nav [aria-pressed="true"] { @apply tw:text-accent tw:border-accent; background: var(--accent-soft); }
.runtime-task-list { flex:1; overflow:hidden; }
.runtime-task-list nav,.runtime-task-list > p { flex-shrink:0; }
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
.runtime-task-list nav .btn { border-color:transparent; }
.runtime-task-list :disabled { @apply tw:text-disabled; }
</style>
