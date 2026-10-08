<script setup lang="ts">
import { onScopeDispose, shallowRef, ref, watch } from 'vue'
import { getRuntimeTask, type TaskRecord } from '@/api/runtimeTasks'
import RuntimeTaskResult from './RuntimeTaskResult.vue'

const props = defineProps<{ taskId: string; revision: number }>()
const task = shallowRef<TaskRecord | null>(null), error = ref(''), retry = ref(0)
let controller: AbortController | undefined
watch(() => [props.taskId, props.revision, retry.value], async () => {
  controller?.abort(); const request = new AbortController(); controller = request
  // A delivery-state update must not remount the same media preview and fetch its pixels again.
  if (task.value?.taskId !== props.taskId) task.value = null
  error.value = ''
  try {
    const result = await getRuntimeTask(props.taskId, request.signal)
    if (!request.signal.aborted) task.value = result
  } catch (reason) {
    if (!request.signal.aborted) error.value = reason instanceof Error ? reason.message : '任务详情读取失败'
  }
}, { immediate: true })
onScopeDispose(() => controller?.abort())
</script>

<template>
  <RuntimeTaskResult v-if="task" :task="task" />
  <p v-if="error" role="status">{{ error }} <button class="btn btn-ghost" type="button" @click="retry++">重试读取</button></p>
  <p v-else-if="!task" role="status">正在读取任务详情…</p>
</template>
