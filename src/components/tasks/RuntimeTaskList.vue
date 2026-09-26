<template>
  <section class="runtime-task-list" aria-label="工作区任务和结果收件箱">
    <nav aria-label="工作区任务筛选"><button v-for="filter in filters" :key="filter.id" class="btn btn-ghost" :aria-pressed="selected === filter.id" @click="selected = filter.id">{{ filter.label }}</button><button class="btn btn-ghost" :disabled="busy === 'refresh'" @click="refresh">更新状态</button></nav>
    <p class="inbox-explanation">切换页面后，已接收任务由本地运行时继续处理。结果先保存在收件箱，入册设置保持不变。</p>
    <p v-if="runtimeTaskError || feedback" role="status">{{ feedback || runtimeTaskError }}</p>
    <article v-for="pending in pendingTaskRequests" :key="pending.key" class="runtime-task"><strong>提交结果待确认</strong><p>保留了这次操作的编号；查询不会重新生成。</p><button class="btn btn-ghost" @click="refresh">查询接收状态</button><button class="btn btn-ghost" @click="cancelKey(pending.key)">取消这次提交</button></article>
    <article v-for="task in visible" :key="task.taskId" class="runtime-task">
      <header><strong>{{ titles[task.kind] }}</strong><span>{{ task.recoveryState !== 'normal' ? '待核对' : labels[task.status] }}</span></header>
      <p>{{ taskMessage(task) }}</p><time :datetime="new Date(task.createdAt).toISOString()">{{ new Date(task.createdAt).toLocaleString('zh-CN') }}</time>
      <div class="runtime-actions">
        <RouterLink class="btn btn-ghost" :to="routeFor(task)" @click="emit('navigate')">返回工作台</RouterLink>
        <button v-if="task.resultRefs.length" class="btn btn-primary" @click="expanded = expanded === task.taskId ? '' : task.taskId">{{ expanded === task.taskId ? '收起结果' : '查看结果' }}</button>
        <button v-if="!task.upstreamSettled" class="btn btn-ghost" :disabled="!!busy" @click="act(task, 'cancel')">取消任务</button>
        <button v-if="task.deliveryState !== 'discarded' && (task.recoveryState !== 'normal' || task.resultState === 'unavailable')" class="btn btn-ghost" :disabled="!!busy" @click="act(task, 'reconcile')">重新核对</button>
        <button v-if="task.status === 'queued' && !task.submissionIntentAt" class="btn btn-ghost" :disabled="!!busy" @click="act(task, 'resume')">继续生成</button>
        <button v-if="task.errorCode === 'BATCH_AWAITING_EXPLICIT_CONTINUE'" class="btn btn-ghost" :disabled="!!busy" @click="act(task, 'continue')">继续剩余分镜</button>
        <button v-if="task.kind === 'batch' && task.status === 'succeeded' && task.resultRefs.length > 1 && !hasConcat(task)" class="btn btn-ghost" :disabled="!!busy" @click="act(task, 'concat')">拼接成片</button>
        <button v-if="task.upstreamSettled && task.resultState === 'available'" class="btn btn-ghost" :disabled="!!busy" @click="discarding = task.taskId">移出收件箱</button>
      </div>
      <p v-if="discarding === task.taskId">已入册作品会保留；未入册结果将从收件箱移除。<button class="btn btn-ghost" :disabled="!!busy" @click="act(task, 'discard')">确认移出</button><button class="btn btn-ghost" @click="discarding = ''">保留结果</button></p>
      <RuntimeTaskResult v-if="expanded === task.taskId && task.resultRefs.length && task.deliveryState !== 'discarded'" :task="task" />
    </article>
    <p v-if="!visible.length" class="runtime-empty">{{ selected === 'inbox' ? '暂时没有未入册结果。' : '这里会保留已接收任务和可找回的结果。' }}</p>
  </section>
</template>
<script setup lang="ts">
import { computed, ref } from 'vue'
import RuntimeTaskResult from './RuntimeTaskResult.vue'
import { runtimeTasks, runtimeTaskError, pendingTaskRequests, refreshRuntimeTasks, taskMessage, cancelRuntimeTask, cancelRuntimeTaskKey, actOnRuntimeTask, markRuntimeTask, type TaskRecord } from '@/api/runtimeTasks'
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
async function act(task: TaskRecord, action: 'cancel' | 'reconcile' | 'resume' | 'continue' | 'concat' | 'discard') {
  if (busy.value) return; busy.value = task.taskId; feedback.value = ''
  try { if (action === 'cancel') await cancelRuntimeTask(task.taskId); else if (action === 'discard') { await markRuntimeTask(task.taskId, 'discarded'); expanded.value = ''; discarding.value = '' } else await actOnRuntimeTask(task.taskId, action) }
  catch (error) { feedback.value = error instanceof Error ? error.message : '操作尚未完成，请重新核对。' }
  finally { busy.value = '' }
}
</script>
<style scoped>
.runtime-task-list { display: grid; gap: var(--s-3); min-height: 100px; }
.runtime-task-list nav, .runtime-actions { display: flex; flex-wrap: wrap; gap: var(--s-2); }
.runtime-task-list nav [aria-pressed="true"] { color: var(--accent); border-color: var(--accent); background: var(--accent-soft); }
.runtime-task { padding: var(--s-4); border: 1px solid var(--border-soft); border-radius: var(--r-lg); background: var(--bg-deep); }
.runtime-task header { display: flex; justify-content: space-between; gap: var(--s-3); }
.runtime-task p, .runtime-task time, .runtime-task span, .inbox-explanation, .runtime-empty { color: var(--text-secondary); font-size: var(--fs-label); line-height: var(--lh-body); }
.runtime-task p { margin: var(--s-2) 0; }
.runtime-actions { margin-top: var(--s-3); }
.runtime-task-list :disabled { color: var(--text-disabled); }
</style>
