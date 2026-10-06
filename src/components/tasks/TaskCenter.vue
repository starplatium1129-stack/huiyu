<template>
  <Teleport to="body"><dialog ref="dialog" class="task-center" aria-labelledby="task-center-title" @click="onDialogClick" @cancel.prevent="opened = false" @close="onClosed">
    <header data-fluid-glass><div><h2 id="task-center-title">任务中心</h2><p>{{ activeCount ? `${activeCount} 项正在处理，切换工作区可继续查看进度。` : '创作进度与最近完成的任务都在这里。' }}</p></div><button class="btn btn-ghost btn-sm btn-icon" type="button" aria-label="关闭任务中心" @click="opened = false"><ArchiveIcon name="close" /></button></header>
    <RuntimeTaskList v-if="runtimeTasksEnabled" :active="opened" @navigate="opened = false" />
    <details :open="!runtimeTasksEnabled"><summary>{{ runtimeTasksEnabled ? '旧版本任务摘要 · 仅供查看' : '任务与进度' }}</summary>
    <div data-disclosure-content class="task-disclosure tw:flex tw:flex-col tw:gap-s-3 tw:flex-1 tw:min-h-0">
    <div v-if="!runtimeTasksEnabled" class="task-center-controls tw:flex tw:flex-wrap tw:items-center tw:gap-s-2"><div class="studio-segments studio-segments--compact" data-fluid-glass role="group" aria-label="任务筛选"><AnimatedSelection /><button v-for="filter in filters" :key="filter.id" class="btn btn-ghost" type="button" :aria-pressed="selected === filter.id" @click="selected = filter.id">{{ filter.label }}</button></div><button class="btn btn-ghost" type="button" @click="clearCompleted">清理完成记录</button><button class="btn btn-ghost" type="button" :disabled="refreshing" @click="refresh">{{ refreshing ? '查询中…' : '更新任务状态' }}</button></div>
    <p v-if="storageError" role="status">{{ storageError }}</p><p v-if="recoveryError" role="status">{{ recoveryError }}</p><p v-if="feedback" role="status">{{ feedback }}</p>
    <div v-content-motion="selected" class="task-list tw:overflow-y-auto tw:min-h-[120px] tw:grid tw:gap-s-3"><article v-for="task in visible" :key="task.id" class="task-card tw:p-s-4 tw:rounded-lg" :data-state="task.status"><div class="task-card-title"><strong>{{ task.title }}</strong><span>{{ (task.status === 'running' && task.stage ? GENERATION_STAGE_LABELS[task.stage] : labels[task.status]) || '待检查' }}</span></div><p>{{ task.message }}</p><progress v-if="task.status === 'running' && task.progress != null" :value="task.progress" max="100" :aria-label="task.title + '进度'" /><div class="task-actions tw:mt-s-3"><RouterLink class="btn btn-ghost" :to="task.route" @click="opened = false">返回工作台</RouterLink><RouterLink v-if="task.resultRoute && task.status !== 'running'" class="btn btn-primary" :to="task.resultRoute" @click="opened = false">查看结果</RouterLink><button v-if="task.status === 'running' && (controls(task.id)?.cancel || (!controls(task.id) && task.backend))" class="btn btn-ghost" type="button" :disabled="!!busy" @click="act(task.id, 'cancel')">停止</button><button v-if="task.status === 'failed' && controls(task.id)?.retry" class="btn btn-ghost" type="button" :disabled="!!busy" @click="act(task.id, 'retry')">重试失败项</button></div></article><p v-if="!visible.length" class="task-empty tw:p-s-5 tw:text-center">{{ selected === 'all' ? '还没有任务。开始创作后，这里会显示进度。' : '这个分类暂时没有任务。' }}</p></div>
    </div></details>
    <footer>{{ runtimeTasksEnabled ? '关闭任务面板只停止查看。退出应用后的恢复能力取决于生成引擎；未知状态会保留，结果不会自动入册。' : '刷新或关闭窗口会中断页面内调度；视频可回工作台重新查询，已入册图片保留在作品册。' }}</footer>
  </dialog></Teleport>
</template>
<script setup lang="ts">
import { GENERATION_STAGE_LABELS } from '@/utils/generationTask'
import { computed, onMounted, onUnmounted, ref, watch, nextTick } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import { useTaskCenter, hydrateTasks, consumeTaskReloadApproval, type TaskStatus } from '@/composables/useTaskCenter'
import { startRuntimeTaskPolling } from '@/api/runtimeTasks'
import { runtimeTasksEnabled } from '@/stores/runtimeTaskState'
import RuntimeTaskList from './RuntimeTaskList.vue'
import { useTaskRecovery } from '@/composables/tasks/useTaskRecovery'
import { useFluidDialog, isBackdropClick } from '@/composables/useFluidDialog'
const recovery = useTaskRecovery()
const { refreshing, error: recoveryError, refresh } = recovery
const { tasks, opened, activeCount, controls, storageError, clearCompleted } = useTaskCenter()
const dialog = ref<HTMLDialogElement | null>(null), selected = ref('all'), busy = ref(''), feedback = ref('')
// Frequent inspection responds immediately; native focus and scroll ownership stay intact.
const motion = useFluidDialog(dialog, { enter: (_el, done) => done(), leave: (_el, done) => done(), dispose: () => {} })
const filters = [{ id: 'all', label: '全部' }, { id: 'running', label: '进行中' }, { id: 'attention', label: '待处理' }, { id: 'succeeded', label: '已完成' }]
const labels: Record<TaskStatus, string> = { idle: '待开始', running: '进行中', succeeded: '已完成', failed: '失败', cancelled: '已停止', interrupted: '待检查' }
const visible = computed(() => tasks.value.filter(task => selected.value === 'all' || (selected.value === 'attention' ? ['failed', 'interrupted'].includes(task.status) : task.status === selected.value)))
function onDialogClick(event: MouseEvent) { if (isBackdropClick(event, dialog.value)) opened.value = false }
function onClosed() { if (!dialog.value?.open) opened.value = false }
watch(opened, async value => {
  const source = document.activeElement as HTMLElement | null
  await nextTick()
  const el = dialog.value
  if (!el || value !== opened.value) return
  if (value) motion.open(source)
  else if (el.open) motion.close()
})
const beforeUnload = (event: BeforeUnloadEvent) => { if (!runtimeTasksEnabled.value && activeCount.value && !consumeTaskReloadApproval()) { event.preventDefault(); event.returnValue = '' } }
let stopRuntime = () => {}
onMounted(() => { stopRuntime = startRuntimeTaskPolling(); if (runtimeTasksEnabled.value) void hydrateTasks().catch(() => {}); else void refresh(); window.addEventListener('beforeunload', beforeUnload) })
onUnmounted(() => { stopRuntime(); window.removeEventListener('beforeunload', beforeUnload) })
async function act(id: string, action: 'cancel' | 'retry') { if (busy.value) return; busy.value = id; feedback.value = ''; try { const handler = controls(id)?.[action]; await (handler ? handler() : action === 'cancel' ? recovery.cancel(id) : undefined) } catch { feedback.value = '操作未完成，请回工作台检查后重试。' } finally { busy.value = '' } }
</script>
<style scoped>
@reference "../../assets/css/tailwind.css";
.task-center { @apply tw:m-auto; width: min(780px, calc(100vw - 28px)); max-height: calc(100dvh - 40px); @apply tw:p-s-5; border: 1px solid var(--glass-edge); @apply tw:rounded-2xl; background: var(--bg-surface); @apply tw:text-primary; box-shadow: var(--shadow-glass-elevated); }
.task-center[open] { @apply tw:flex tw:flex-col tw:gap-s-4; }
.task-center { @apply tw:overflow-hidden; }
.task-center > details { @apply tw:min-h-0; }
.task-center > details[open] { display:flex; flex-direction:column; flex:1; overflow:hidden; }
.task-center > header,.task-center > footer,.task-center-controls { flex-shrink:0; }
.task-center .task-list { flex:1; overscroll-behavior:contain; scrollbar-width:thin; padding-right:var(--s-1); }
.task-center summary { @apply tw:cursor-pointer tw:text-secondary tw:text-label; margin-block: var(--s-2); }
.task-center::backdrop { background: var(--art-scrim); }
.task-center header, .task-card-title { @apply tw:flex; align-items: start; @apply tw:justify-between tw:gap-s-3; }
.task-center h2 { @apply tw:m-0 tw:text-title-sm; letter-spacing:-.02em; }
.task-center p, .task-center footer { margin: var(--s-2) 0 0; @apply tw:text-label tw:text-secondary tw:leading-body; }
.task-actions { @apply tw:flex tw:flex-wrap tw:gap-s-2; }
.task-card { border:0; background:var(--bg-base); }
.task-center > header { padding-bottom:var(--s-3); border-bottom:1px solid var(--border-soft); }
.task-center > footer { padding-top:var(--s-3); border-top:1px solid var(--border-soft); }
.task-card-title strong { @apply tw:text-body-sm; overflow-wrap: anywhere; }
.task-card-title span { @apply tw:shrink-0 tw:text-secondary tw:text-label; }
.task-card[data-state="failed"] .task-card-title span { @apply tw:text-warning-text; }
.task-card progress {
  @apply tw:block tw:w-full tw:h-[6px];
  margin-block: var(--s-3);
  @apply tw:overflow-hidden;
  border: 0;
  @apply tw:rounded-pill;
  background: color-mix(in srgb, var(--border-soft) 80%, transparent);
  -webkit-appearance: none;
  appearance: none;
}
.task-card progress::-webkit-progress-bar {
  background: color-mix(in srgb, var(--border-soft) 80%, transparent);
}
.task-card progress::-webkit-progress-value {
  @apply tw:rounded-pill;
  background: linear-gradient(90deg, var(--archive-cyan, var(--accent)), var(--accent));
  box-shadow: 0 0 8px -1px var(--accent-glow);
}
.task-card progress::-moz-progress-bar {
  @apply tw:rounded-pill;
  background: linear-gradient(90deg, var(--archive-cyan, var(--accent)), var(--accent));
  box-shadow: 0 0 8px -1px var(--accent-glow);
}
@media (prefers-reduced-motion: reduce) { .task-center[open] { animation: none; } }
</style>
