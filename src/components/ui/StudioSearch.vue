<script setup lang="ts">
import { ref, nextTick } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
defineProps<{ label: string; placeholder?: string; id?: string }>()
const value = defineModel<string>({ required: true })
const emit = defineEmits<{ keydown: [event: KeyboardEvent] }>()
const input = ref<HTMLInputElement | null>(null)
async function clear() { value.value = ''; await nextTick(); input.value?.focus() }
function keydown(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return
  if (event.key === 'Escape' && value.value) { event.preventDefault(); event.stopPropagation(); void clear() }
  emit('keydown', event)
}
defineExpose({ focus: (options?: FocusOptions) => input.value?.focus(options) })
</script>
<template>
  <div class="studio-search">
    <ArchiveIcon name="search" />
    <input :id="id" ref="input" v-model="value" class="studio-search-input" type="search" :aria-label="label" :placeholder="placeholder" @keydown="keydown" />
    <button v-if="value" type="button" aria-label="清空搜索" @click="clear"><ArchiveIcon name="close" /></button>
  </div>
</template>
<style scoped>
.studio-search { display:flex; align-items:center; gap:var(--s-2); min-width:0; padding:0 var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-pill); background:var(--bg-base); color:var(--text-secondary); }
.studio-search:focus-within { border-color:var(--accent); box-shadow:0 0 0 1px var(--accent); }
.studio-search input { width:100%; min-width:0; min-height:44px; padding:var(--s-2) 0; border:0; outline:0; background:transparent; color:var(--text-primary); font:400 var(--fs-body-sm) var(--font-sans); appearance:none; }
.studio-search input:focus-visible { outline:0; box-shadow:none; }
.studio-search input::-webkit-search-cancel-button { display:none; }
.studio-search input::placeholder { color:var(--text-muted); }
.studio-search button { display:grid; place-items:center; flex:0 0 32px; width:32px; height:32px; border:0; border-radius:var(--r-pill); background:transparent; color:var(--text-secondary); cursor:pointer; }
.studio-search button:hover { background:var(--accent-soft); color:var(--accent); }
.studio-search button:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
</style>
