<template><span hidden aria-hidden="true" /></template>
<script setup lang="ts">
import type { useLegacySdTasks } from '@/composables/generation/useLegacySdTasks'
import type { useAnimaSession } from '@/composables/generation/useAnimaSession'
import { useDrawingTaskTracking } from '@/composables/generation/useDrawingTaskTracking'
const props = defineProps<{ sd: ReturnType<typeof useLegacySdTasks>; anima: ReturnType<typeof useAnimaSession> }>()
useDrawingTaskTracking(props.sd, props.anima)
</script>
