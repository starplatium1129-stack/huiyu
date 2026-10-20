<script setup lang="ts">
import { ref, nextTick } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
const props = withDefaults(defineProps<{ label: string; placeholder?: string; id?: string; clearOnEscape?: boolean; autofocus?: boolean; autocomplete?: string; size?: 'sm' | 'md' }>(), { clearOnEscape: true, autofocus: false, size: 'md' })
const value = defineModel<string>({ required: true })
const emit = defineEmits<{ keydown: [event: KeyboardEvent] }>()
const field = ref<HTMLElement | null>(null)
const input = ref<HTMLInputElement | null>(null)
function focus(options?: FocusOptions) { (input.value ?? field.value?.querySelector('input'))?.focus(options) }
async function clear() { value.value = ''; await nextTick(); focus() }
function keydown(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return
  if (event.key === 'Escape' && value.value && props.clearOnEscape) { event.preventDefault(); event.stopPropagation(); void clear() }
  emit('keydown', event)
}
defineExpose({ focus })
</script>
<template>
  <div ref="field" :data-size="size" class="studio-search" @keydown="keydown">
    <ArchiveIcon name="search" />
    <slot name="input" :input-props="{ id, autofocus, autocomplete, class: 'studio-search-input', type: 'search', 'aria-label': label, placeholder }">
      <input :id="id" ref="input" v-model="value" :autofocus="autofocus" :autocomplete="autocomplete" class="studio-search-input" type="search" :aria-label="label" :placeholder="placeholder" />
    </slot>
    <button v-if="value" type="button" class="studio-search-clear" aria-label="清空搜索" @click="clear"><ArchiveIcon name="close" /></button>
  </div>
</template>
<!-- Slot-provided inputs share the same field geometry and states. -->
<style>
.studio-search { position:relative; isolation:isolate; display:flex; align-items:center; gap:var(--s-2); padding-block:0; color:var(--text-secondary); box-shadow:inset 0 1px 0 var(--glass-highlight); }
.studio-search::before { content:''; position:absolute; z-index:-1; inset:0; border:1px solid var(--control-hover-edge); border-radius:inherit; background:var(--control-hover-surface); opacity:0; transition:opacity var(--motion-hover) var(--ease-out); pointer-events:none; }
.studio-search:focus-within::before { opacity:1; }
.studio-search-input { width:100%; min-width:0; min-height:calc(var(--control-height) - 2px); padding:var(--s-2) 0; border:0; outline:0; background:transparent; color:var(--text-primary); font:400 var(--fs-body-sm)/var(--lh-label) var(--font-sans); appearance:none; }
.studio-search[data-size='sm'] { gap:var(--s-1); padding-inline:var(--s-2); }
.studio-search[data-size='sm'] .studio-search-input { min-height:calc(var(--control-height-sm) - 2px); padding-block:var(--s-1); font-size:var(--fs-label-sm); }
.studio-search[data-size='sm'] .studio-search-clear { flex-basis:28px; width:28px; height:28px; }
.studio-search[data-size='sm'] { min-height:var(--control-height-sm); }
.studio-search:has(.studio-search-input:focus-visible)::before { border-color:var(--focus-color); transition:none; }
.studio-search > .archive-icon { transition:transform var(--motion-hover) var(--ease-out); }
.studio-search:focus-within > .archive-icon { color:var(--text-primary); }
.studio-search:has(.studio-search-input:focus-visible) > .archive-icon { transition:none; }
@media (hover:hover) and (pointer:fine) {
  .studio-search:where(:hover:not(:focus-within))::before { opacity:.75; }
  .studio-search:where(:hover:not(:focus-within)) > .archive-icon { color:var(--text-primary); }
  .studio-search-clear:hover { background:transparent; color:var(--text-primary); }
}
.studio-search-clear { display:grid; place-items:center; flex:0 0 32px; width:32px; height:32px; padding:0; border:0; border-radius:var(--r-sm); background:transparent; color:var(--text-secondary); cursor:pointer; animation:search-clear-in var(--motion-surface) var(--spring-bounce); }
@keyframes search-clear-in { from { opacity:0; transform:scale(.6) rotate(-45deg); } }
.studio-search input:focus-visible { outline:0; box-shadow:none; }
.studio-search input::-webkit-search-cancel-button { display:none; }
.studio-search input::placeholder { color:var(--text-muted); }
.studio-search button:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
@media (pointer:coarse) {
  .studio-search,.studio-search[data-size='sm'] { min-height:46px; }
  .studio-search .studio-search-input { min-height:44px; }
  .studio-search .studio-search-clear { flex-basis:44px; width:44px; height:44px; }
}
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
