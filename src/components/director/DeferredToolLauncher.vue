<script setup lang="ts">
import type { Component } from 'vue'
import ArchiveIcon, { type ArchiveIconName } from '@/components/visual/ArchiveIcon.vue'
import StudioOrbitSpinner from '@/components/ui/StudioOrbitSpinner.vue'
import { useDeferredToolLauncher } from '@/composables/prompt/useDeferredToolLauncher'

const props = defineProps<{ label: string; icon: ArchiveIconName; loader: () => Promise<{ default: Component }>; disabled?: boolean; migrationControl?: boolean; row?: boolean }>()
const emit = defineEmits<{ error: [message: string] }>()
defineSlots<{ default(props: { component: Component; open: boolean; update: (value: boolean) => void }): unknown }>()
const { host, panel, loading, requested, open, toggle, update } = useDeferredToolLauncher(
  props.loader, () => props.disabled === true, () => emit('error', `${props.label}暂未加载，请刷新页面后重试。`),
)
</script>

<template>
  <div ref="host" class="deferred-tool-launcher">
    <slot v-if="panel" :component="panel" :open="open" :update="update" />
    <button v-else class="btn" :class="row ? 'btn-quiet image-tool-action' : 'btn-ghost btn-sm'" type="button" :data-migration-control="migrationControl ? '' : undefined" data-control-motion
      :aria-label="label" aria-haspopup="dialog" :aria-expanded="requested" :aria-busy="loading" :disabled="disabled" @click="toggle">
      <span v-if="loading && requested" class="tool-launcher-spinner"><StudioOrbitSpinner /></span><ArchiveIcon v-else :name="icon" />
      <span class="studio-control-label">{{ label }}</span>
      <ArchiveIcon v-if="row" name="chevron-down" class="image-tool-chevron" />
    </button>
    <span v-if="loading && requested" class="sr-only" role="status">正在准备{{ label }}…</span>
  </div>
</template>

<style scoped>
.deferred-tool-launcher { display:inline-flex; align-items:center; min-width:0; }
.tool-launcher-spinner { display:grid; place-items:center; flex:none; width:18px; height:18px; }
.tool-launcher-spinner :deep(.studio-orbit-spinner) { transform:scale(.45); }
</style>
