<script setup lang="ts">
import { defineAsyncComponent, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { startRuntimeTaskPolling } from '@/api/runtimeTasks'
import { useTaskRecovery } from '@/composables/tasks/useTaskRecovery'
import { consumeTaskReloadApproval, hydrateTasks, useTaskCenter } from '@/composables/useTaskCenter'
import { runtimeTasksEnabled } from '@/stores/runtimeTaskState'

const TaskCenterDialog = defineAsyncComponent(() => import('./TaskCenterDialog.vue'))
const recovery = useTaskRecovery()
const { opened, openRuntimeTasks, pageActiveCount } = useTaskCenter()
const route = useRoute(), router = useRouter()
const selected = ref('all')
const inspected = ref(opened.value)
watch(opened, value => { if (value) inspected.value = true })

watch(() => route.query.tasks, async intent => {
  if (intent !== 'inbox') return
  selected.value = 'succeeded'
  openRuntimeTasks()
  await router.replace({ path: route.path, query: { ...route.query, tasks: undefined }, hash: route.hash })
}, { immediate: true, flush: 'post' })
const beforeUnload = (event: BeforeUnloadEvent) => { if (pageActiveCount.value && !consumeTaskReloadApproval(event)) { event.preventDefault(); event.returnValue = '' } }
let stopRuntime = () => {}
watch(() => pageActiveCount.value > 0, (busy, _previous, onCleanup) => {
  if (!busy) return
  window.addEventListener('beforeunload', beforeUnload)
  onCleanup(() => window.removeEventListener('beforeunload', beforeUnload))
}, { immediate: true, flush: 'sync' })
onMounted(() => { stopRuntime = startRuntimeTaskPolling(); if (runtimeTasksEnabled.value) void hydrateTasks().catch(() => {}); else void recovery.refresh() })
onUnmounted(() => stopRuntime())
</script>

<template>
  <TaskCenterDialog v-if="inspected" v-model:selected="selected" :recovery="recovery" />
</template>
