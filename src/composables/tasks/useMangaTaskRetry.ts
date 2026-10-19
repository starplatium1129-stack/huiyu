import { nextTick, onScopeDispose, ref, type Ref } from 'vue'
import { getRuntimeTaskSummary, retryRuntimeMangaTask, type TaskSummary } from '@/api/runtimeTasks'
import { ApiClientError } from '@/api/client'
import { pendingTaskRequests } from '@/stores/runtimeTaskState'
import { getDesktopRuntime } from '@/platform/desktop/runtime'
import { summarizeTask } from '@/utils/runtimeTaskSummary'

// Task HTTP deliberately redacts internal errors. Explain known retry failures
// locally instead of displaying private filesystem paths or a generic failure.
const retryErrors: Record<string, string> = {
  TASK_ACTION_BUSY: '这条任务正在核对或准备重试，请稍后查询原操作。',
  TASK_RETRY_UNSAFE: '原任务尚未确认结束、已取消或状态有变化，请先重新核对。',
  TASK_RETRY_PROVIDER_CHANGED: '原生运行配置已改变，请恢复原配置，或回漫画化入口创建新任务。',
  TASK_RESUME_UNSAFE: '原图、外部线稿或冻结配方不能原样恢复，请核对素材和版本，或回漫画化入口新建任务。',
  TASK_INPUT_MISSING: '原图或外部线稿尚未完整持久化，不能一键重试；请回漫画化入口重新导入。',
  TASK_INPUT_INVALID: '已保存的原图或外部线稿无效，请核对工作区素材。',
  TASK_INPUT_CHANGED: '已保存的任务素材发生变化，已停止重试，请核对原图。',
  TASK_INPUT_FORBIDDEN: '无权读取原任务素材，请切回原私人工作区。',
  TASK_RETRY_PREPARE_TIMEOUT: '读取原任务素材超时，尚未接收重试；请核对工作区磁盘后再试。',
  TASK_PROVIDER_BUSY: '工作区还有未结束或待核对的任务，请先处理它，再重试。',
  ANIMA_QUEUE_FULL: '原生图像队列已满或正在交接显存，请稍后重试。',
  TASK_KEY_CONFLICT: '重试编号与已有记录不符，请更新任务状态后核对。',
  TASK_NOT_FOUND: '原任务或关联任务不存在，请确认当前私人工作区。',
  MANGA_LINE_MODEL_MISSING: '缺少完整的线稿本地权重，请在主力机准备 manga-line-extraction/erika.pth 后重试。',
  MANGA_RUNTIME_MISSING: '漫画独立环境或随包文件不完整，请在控制室核对原生环境。',
  NATIVE_ADAPTER_RUNTIME_MISSING: 'Qwen 独立环境尚未准备好，请在控制室核对配置。',
  NATIVE_MODEL_UNAVAILABLE: 'Qwen 本地模型目录缺失、不完整或尚未核验，请在主力机准备对应权重后重试。',
  NATIVE_RUNTIME_UNAVAILABLE: '原生 Python 或处理脚本不可用，请在控制室核对配置。',
  NATIVE_CONFIG_INVALID: '原生配置无效，请在控制室修正后重试。',
  STORAGE_UNAVAILABLE: '无法读取已保存素材，请检查私人工作区磁盘和访问权限。',
}
function retryMessage(error: unknown): string {
  if (error instanceof ApiClientError && error.kind === 'http' && error.code) return retryErrors[error.code]
    ?? `重试未完成（${error.code}），请核对原生环境及任务状态。`
  return error instanceof Error ? error.message : '重试尚未确认，请查询原操作。'
}

export function useMangaTaskRetry(options: {
  busy: Ref<string>; feedback: Ref<string>; active: () => boolean
  reveal: (task: TaskSummary) => Promise<void>; cardId: (id: string) => string
}) {
  const { busy, feedback } = options
  const locating = ref('')
  const epoch = () => getDesktopRuntime().bootstrap?.runtime?.workspace?.runtimeEpoch || ''
  let disposed = false
  const reads = new AbortController()
  onScopeDispose(() => { disposed = true; reads.abort() })
  const canRetry = (task: TaskSummary) => (task.kind === 'manga' || task.kind === 'lineart')
    && task.provider === 'native' && task.status === 'failed' && task.upstreamSettled
    && task.recoveryState === 'normal' && !task.cancelRequestedAt
  const pendingRetry = (task: TaskSummary) => pendingTaskRequests.value.some(request => request.key === `manga-retry:${task.taskId}`)
  async function locate(task: TaskSummary) {
    await options.reveal(task)
    await nextTick()
    if (!disposed && options.active() && task.runtimeEpoch === epoch()) document.getElementById(options.cardId(task.taskId))?.focus()
  }
  async function retry(task: TaskSummary) {
    if (busy.value || pendingRetry(task) || !canRetry(task)) return
    const expected = epoch()
    busy.value = `retry:${task.taskId}`; feedback.value = ''
    try {
      const child = await retryRuntimeMangaTask(task, reads.signal)
      if (disposed || epoch() !== expected) return
      feedback.value = '已找到这条记录对应的重试任务，沿用已保存的原图和参数。原记录及结果保留。待主力机验证。'
      await locate(summarizeTask(child))
      // Do not delay the accepted task's controls while updating its source link.
      if (!disposed && epoch() === expected) void getRuntimeTaskSummary(task.taskId, reads.signal).catch(() => {})
    } catch (error) {
      if (!disposed && epoch() === expected) feedback.value = retryMessage(error)
    } finally { busy.value = '' }
  }
  async function openRelated(id: string) {
    if (locating.value) return
    const expected = epoch()
    locating.value = id; feedback.value = ''
    try {
      const task = await getRuntimeTaskSummary(id, reads.signal)
      if (disposed || epoch() !== expected) return
      await locate(task)
    } catch (error) {
      if (!disposed && epoch() === expected) feedback.value = retryMessage(error)
    } finally { locating.value = '' }
  }
  return { canRetry, pendingRetry, retry, openRelated, locating }
}
