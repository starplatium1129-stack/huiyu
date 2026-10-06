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
  <div data-fluid-glass class="studio-search tw:flex tw:items-center tw:gap-s-2 tw:min-w-0 tw:py-0 tw:px-s-3 tw:border-0 tw:rounded-pill tw:bg-surface tw:text-secondary">
    <ArchiveIcon name="search" />
    <input :id="id" ref="input" v-model="value" class="studio-search-input tw:w-full tw:min-w-0 tw:min-h-[38px] tw:py-s-2 tw:px-0 tw:border-0 tw:[outline:0] tw:bg-transparent tw:text-primary tw:[font:400_var(--fs-body-sm)_var(--font-sans)] tw:appearance-none" type="search" :aria-label="label" :placeholder="placeholder" @keydown="keydown" />
    <button v-if="value" type="button" class="tw:grid tw:place-items-center tw:[flex:0_0_32px] tw:w-[32px] tw:h-[32px] tw:border-0 tw:rounded-pill tw:bg-transparent tw:text-secondary tw:cursor-pointer" aria-label="清空搜索" @click="clear"><ArchiveIcon name="close" /></button>
  </div>
</template>
<style scoped>
.studio-search:focus-within { border-color:var(--accent); box-shadow:0 0 0 1px var(--accent); }
.studio-search input:focus-visible { outline:0; box-shadow:none; }
.studio-search input::-webkit-search-cancel-button { display:none; }
.studio-search input::placeholder { color:var(--text-muted); }
.studio-search button:hover { background:var(--accent-soft); color:var(--accent); }
.studio-search button:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
@media(forced-colors:active) { .studio-search:focus-within { outline:2px solid Highlight; outline-offset:2px; box-shadow:none; } }
</style>
