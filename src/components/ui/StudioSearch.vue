<script setup lang="ts">
import { ref, nextTick } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
const props = withDefaults(defineProps<{ label: string; placeholder?: string; id?: string; clearOnEscape?: boolean; autofocus?: boolean; autocomplete?: string; size?: 'sm' | 'md' }>(), { clearOnEscape: true, autofocus: false, size: 'md' })
const value = defineModel<string>({ required: true })
const emit = defineEmits<{ keydown: [event: KeyboardEvent] }>()
const input = ref<HTMLInputElement | null>(null)
async function clear() { value.value = ''; await nextTick(); input.value?.focus() }
function keydown(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return
  if (event.key === 'Escape' && value.value && props.clearOnEscape) { event.preventDefault(); event.stopPropagation(); void clear() }
  emit('keydown', event)
}
defineExpose({ focus: (options?: FocusOptions) => input.value?.focus(options) })
</script>
<template>
  <div data-fluid-glass :data-size="size" class="studio-search tw:flex tw:items-center tw:gap-s-2 tw:min-w-0 tw:py-0 tw:px-s-3 tw:border-0 tw:rounded-pill tw:bg-surface tw:text-secondary">
    <ArchiveIcon name="search" />
    <input :id="id" ref="input" v-model="value" :autofocus="autofocus" :autocomplete="autocomplete" class="studio-search-input tw:w-full tw:min-w-0 tw:py-s-2 tw:px-0 tw:border-0 tw:[outline:0] tw:bg-transparent tw:text-primary tw:[font:400_var(--fs-body-sm)_var(--font-sans)] tw:appearance-none" type="search" :aria-label="label" :placeholder="placeholder" @keydown="keydown" />
    <button v-if="value" type="button" class="studio-search-clear tw:grid tw:place-items-center tw:[flex:0_0_32px] tw:w-[32px] tw:h-[32px] tw:border-0 tw:rounded-pill tw:bg-transparent tw:text-secondary tw:cursor-pointer" aria-label="清空搜索" @click="clear"><ArchiveIcon name="close" /></button>
  </div>
</template>
<style scoped>
.studio-search { position:relative; isolation:isolate; box-shadow:inset 0 1px 0 var(--glass-highlight); }
.studio-search::before { content:''; position:absolute; z-index:-1; inset:0; border:1px solid var(--border-strong); border-radius:inherit; background:var(--accent-soft); opacity:0; transition:opacity var(--motion-control) var(--ease-out); pointer-events:none; }
.studio-search:focus-within::before { opacity:1; }
.studio-search-input { min-height:var(--control-height); }
.studio-search[data-size='sm'] { gap:var(--s-1); padding-inline:var(--s-2); }
.studio-search[data-size='sm'] .studio-search-input { min-height:var(--control-height-sm); padding-block:var(--s-1); font-size:var(--fs-label-sm); }
.studio-search:has(.studio-search-input:focus-visible)::before { border-color:var(--focus-color); transition:none; }
.studio-search > .archive-icon { transition:transform var(--motion-route) var(--spring-soft); }
.studio-search:focus-within > .archive-icon { transform:scale(1.08); }
.studio-search:has(.studio-search-input:focus-visible) > .archive-icon { transition:none; }
@media (hover:hover) and (pointer:fine) {
  .studio-search:where(:hover:not(:focus-within))::before { opacity:.75; }
  .studio-search:where(:hover:not(:focus-within)) > .archive-icon { transform:translateY(-1px) rotate(-12deg) scale(1.16); }
}
.studio-search-clear { animation:search-clear-in var(--motion-surface) var(--spring-bounce); }
@keyframes search-clear-in { from { opacity:0; transform:scale(.6) rotate(-45deg); } }
.studio-search input:focus-visible { outline:0; box-shadow:none; }
.studio-search input::-webkit-search-cancel-button { display:none; }
.studio-search input::placeholder { color:var(--text-muted); }
.studio-search button:hover { background:var(--accent-soft); color:var(--accent); }
.studio-search button:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
@media (prefers-reduced-motion:reduce) {
  :root:not([data-motion='full']) .studio-search::before,
  :root:not([data-motion='full']) .studio-search > .archive-icon { transition:none; }
  :root:not([data-motion='full']) .studio-search > .archive-icon { transform:none; }
  :root:not([data-motion='full']) .studio-search-clear { animation:none; }
}
:root:is([data-motion='reduce'],[data-motion='reduced'],[data-reduced-motion='true']) .studio-search::before,
:root:is([data-motion='reduce'],[data-motion='reduced'],[data-reduced-motion='true']) .studio-search > .archive-icon { transition:none; }
:root:is([data-motion='reduce'],[data-motion='reduced'],[data-reduced-motion='true']) .studio-search > .archive-icon { transform:none; }
:root:is([data-motion='reduce'],[data-motion='reduced'],[data-reduced-motion='true']) .studio-search-clear { animation:none; }
@media(forced-colors:active) { .studio-search:has(.studio-search-input:focus) { outline:2px solid Highlight; outline-offset:2px; } }
</style>
