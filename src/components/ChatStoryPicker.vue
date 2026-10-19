<script setup lang="ts">
import { computed } from 'vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'

const props = defineProps<{
  branchId: string
  branches: readonly { id: string; name: string; parentId?: string }[]
  disabled?: boolean
}>()
const emit = defineEmits<{ select: [id: string] }>()
const options = computed(() => props.branches.map(branch => ({ value: branch.id, label: branch.name })))
const parent = computed(() => props.branches.find(branch => branch.id === props.branchId)?.parentId)
</script>

<template>
  <div class="chat-story-picker">
    <span class="chat-story-label"><ArchiveIcon name="chat" />当前剧情</span>
    <StudioSelect class="chat-story-select" size="sm" label="当前剧情" :model-value="branchId" :options="options" :disabled="disabled"
      @update:model-value="emit('select', String($event))" />
    <button v-if="parent" class="btn btn-ghost btn-sm" type="button" :disabled="disabled" @click="emit('select', parent!)">返回原剧情</button>
  </div>
</template>

<style scoped>
.chat-story-picker { display:flex; flex-shrink:0; align-items:center; flex-wrap:wrap; gap:var(--s-2); min-width:0; padding:var(--s-2) var(--s-4); border-bottom:1px solid var(--border-soft); }
.chat-story-label { display:flex; align-items:center; gap:var(--s-1); flex:none; color:var(--text-secondary); font:400 var(--fs-label-xs)/var(--lh-label) var(--font-sans); }
.chat-story-label .archive-icon { width:16px; height:16px; }
.chat-story-select { flex:1; min-width:0; }
.chat-story-picker > button { flex:none; }
:global(.companion-dialogue-window) .chat-story-picker { margin-bottom:var(--s-2); padding:var(--s-2); border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--dialogue-control-surface); }
</style>
