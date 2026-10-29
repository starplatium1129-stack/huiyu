<script setup lang="ts">
import AsyncPanel from '@/components/ui/AsyncPanel.vue'
import { loadRoom, type RoomPage } from '@/router/roomResources'

const props = defineProps<{ page: RoomPage; label: string }>()
const load = () => loadRoom(props.page)
</script>

<template>
  <AsyncPanel :key="page" :loader="load" :label="label">
    <template #default="{ component }"><component :is="component" /></template>
  </AsyncPanel>
</template>
