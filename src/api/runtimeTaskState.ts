import { computed, ref, toRaw } from 'vue'
import type { TaskRecord } from '../../types/tasks'
export const taskRecords = ref<TaskRecord[]>([])
export const copyTask = (task: TaskRecord) => structuredClone(toRaw(task))
export const runtimeTasks = computed(() => taskRecords.value.map(copyTask))
export const runtimeTasksEnabled = ref(false)
export const runtimeTaskError = ref('')
export const runtimeTaskActiveCount = computed(() => taskRecords.value.filter(task => !task.upstreamSettled).length)
export const unresolvedTaskRequests = new Map<string, { key: string; kind: TaskRecord['kind'] }>()
export const pendingTaskRequests = ref<Array<{ key: string; kind: TaskRecord['kind'] }>>([])
