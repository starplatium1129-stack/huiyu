<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  ComboboxAnchor, ComboboxContent, ComboboxEmpty, ComboboxInput,
  ComboboxItem, ComboboxItemIndicator, ComboboxPortal, ComboboxRoot,
  ComboboxTrigger, ComboboxViewport,
} from 'reka-ui'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'

const props = defineProps<{
  id?: string
  label: string
  options: readonly { value: string; label: string }[]
  disabled?: boolean
}>()
const value = defineModel<string>({ required: true })
const open = ref(false)
const query = ref('')
const displayValue = (key: string) => props.options.find(option => option.value === key)?.label ?? ''
const selectedLabel = computed(() => displayValue(value.value))
// A URL can restore the selected id before its asynchronously loaded label arrives.
watch(selectedLabel, label => { if (!open.value) query.value = label }, { immediate: true })
</script>

<template>
  <ComboboxRoot v-model="value" v-model:open="open" :disabled="disabled" open-on-click class="studio-combobox">
    <ComboboxAnchor class="studio-combobox-anchor">
      <ArchiveIcon name="search" class="studio-combobox-search" aria-hidden="true" />
      <ComboboxInput :id="id" v-model="query" :aria-label="label" :display-value="displayValue"
        :disabled="disabled" placeholder="输入名称查找…" class="studio-combobox-input"
        @focus="($event.target as HTMLInputElement).select()" />
      <ComboboxTrigger class="studio-combobox-trigger" :aria-label="'展开' + label" :disabled="disabled">
        <ArchiveIcon name="chevron-down" aria-hidden="true" />
      </ComboboxTrigger>
    </ComboboxAnchor>
    <ComboboxPortal>
      <ComboboxContent position="popper" align="start" :side-offset="8" :collision-padding="12"
        class="studio-combobox-content" :aria-label="label">
        <div class="studio-combobox-heading" aria-hidden="true">{{ label }}<span>输入名称快速查找</span></div>
        <ComboboxViewport class="studio-combobox-viewport">
          <ComboboxEmpty class="studio-combobox-empty">没有匹配项，试试其他名字</ComboboxEmpty>
          <ComboboxItem v-for="option in options" :key="option.value" :value="option.value"
            :text-value="option.label" class="studio-combobox-option">
            <span>{{ option.label }}</span>
            <ComboboxItemIndicator class="studio-combobox-check"><ArchiveIcon name="success" /></ComboboxItemIndicator>
          </ComboboxItem>
        </ComboboxViewport>
      </ComboboxContent>
    </ComboboxPortal>
  </ComboboxRoot>
</template>

<!-- Reka portals cross component roots; keep these uniquely prefixed rules global. -->
<style>
.studio-combobox { min-width:0; width:100%; }
.studio-combobox-anchor { display:flex; align-items:center; gap:var(--s-2); min-height:40px; padding-left:var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--bg-surface); color:var(--text-secondary); }
.studio-combobox-anchor:focus-within { outline:2px solid var(--accent); outline-offset:2px; }
/* One focus ring surrounds the whole field, including its disclosure button. */
.studio-combobox .studio-combobox-anchor .studio-combobox-input:focus-visible { outline:none; }
.studio-combobox-search { flex-shrink:0; width:16px; height:16px; color:var(--text-muted); }
.studio-combobox-input { width:100%; min-width:0; padding:var(--s-2) 0; border:0; background:transparent; color:var(--text-primary); font:500 var(--fs-label)/var(--lh-label) var(--font-sans); outline:none; }
.studio-combobox-input::placeholder { color:var(--text-muted); }
.studio-combobox-trigger { display:grid; place-items:center; flex:0 0 36px; align-self:stretch; border:0; border-radius:var(--r-md); background:transparent; color:var(--text-secondary); cursor:pointer; }
.studio-combobox-trigger:hover { background:var(--bg-hover); }
.studio-combobox-trigger:focus-visible { outline:2px solid var(--accent); outline-offset:-3px; }
.studio-combobox-trigger .archive-icon { width:16px; height:16px; transition:transform var(--motion-hover); }
.studio-combobox-trigger[data-state='open'] .archive-icon { transform:rotate(180deg); }
.studio-combobox-input:disabled, .studio-combobox-trigger:disabled { color:var(--text-disabled); cursor:not-allowed; }
.studio-combobox-content { z-index:var(--z-popover); width:max(260px,var(--reka-combobox-trigger-width, 260px)); max-width:calc(100vw - 24px); max-height:var(--reka-combobox-content-available-height, 320px); overflow:hidden; padding:var(--s-2); border:1px solid var(--border-soft); border-radius:var(--r-xl); background:var(--bg-surface); box-shadow:var(--shadow-lg); color:var(--text-primary); }
.studio-combobox-heading { display:flex; justify-content:space-between; gap:var(--s-3); padding:var(--s-2); margin-bottom:var(--s-1); border-bottom:1px solid var(--border-soft); font:600 var(--fs-label-sm)/var(--lh-body) var(--font-sans); }
.studio-combobox-heading span { font-weight:400; color:var(--text-muted); }
.studio-combobox-viewport { max-height:min(300px,calc(var(--reka-combobox-content-available-height, 320px) - 64px)); overflow-y:auto; overscroll-behavior:contain; scrollbar-width:thin; }
.studio-combobox-option { display:flex; align-items:center; justify-content:space-between; gap:var(--s-3); min-height:40px; padding:var(--s-2) var(--s-3); border-radius:var(--r-md); font:500 var(--fs-label)/var(--lh-body) var(--font-sans); cursor:pointer; overflow-wrap:anywhere; }
.studio-combobox-option[data-state='checked'] { background:var(--accent-soft); color:var(--accent); }
.studio-combobox-option[data-highlighted] { outline:1px solid var(--accent); outline-offset:-1px; background:var(--bg-hover); }
.studio-combobox-check { display:flex; flex-shrink:0; color:var(--accent); }
.studio-combobox-check .archive-icon { width:16px; height:16px; }
.studio-combobox-empty { padding:var(--s-5) var(--s-3); color:var(--text-secondary); font-size:var(--fs-label); text-align:center; }
@media(max-width:600px) { .studio-combobox-anchor,.studio-combobox-option { min-height:44px; } }
@media(prefers-reduced-motion:reduce) { .studio-combobox-trigger .archive-icon { transition:none; } }
@media(forced-colors:active) { .studio-combobox-content { background:Canvas; border-color:CanvasText; } .studio-combobox-option[data-state='checked'] { outline:1px solid Highlight; outline-offset:-1px; } }
</style>
