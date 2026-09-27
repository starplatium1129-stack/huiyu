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
  <ComboboxRoot v-model="value" v-model:open="open" :disabled="disabled" open-on-click class="studio-combobox tw:min-w-0 tw:w-full">
    <ComboboxAnchor class="studio-combobox-anchor tw:flex tw:items-center tw:gap-s-2 tw:min-h-[40px] tw:pl-s-3 tw:border tw:border-solid tw:border-soft tw:rounded-md tw:bg-surface tw:text-secondary">
      <ArchiveIcon name="search" class="studio-combobox-search tw:shrink-0 tw:w-[16px] tw:h-[16px] tw:text-muted" aria-hidden="true" />
      <ComboboxInput :id="id" v-model="query" :aria-label="label" :display-value="displayValue"
        :disabled="disabled" placeholder="输入名称查找…" class="studio-combobox-input tw:w-full tw:min-w-0 tw:py-s-2 tw:px-0 tw:border-0 tw:bg-transparent tw:text-primary tw:[font:500_var(--fs-label)/var(--lh-label)_var(--font-sans)] tw:[outline:none]"
        @focus="($event.target as HTMLInputElement).select()" />
      <ComboboxTrigger class="studio-combobox-trigger tw:grid tw:place-items-center tw:[flex:0_0_36px] tw:self-stretch tw:border-0 tw:rounded-md tw:bg-transparent tw:text-secondary tw:cursor-pointer" :aria-label="'展开' + label" :disabled="disabled">
        <ArchiveIcon name="chevron-down" aria-hidden="true" />
      </ComboboxTrigger>
    </ComboboxAnchor>
    <ComboboxPortal>
      <ComboboxContent position="popper" align="start" :side-offset="8" :collision-padding="12"
        class="studio-combobox-content tw:[z-index:var(--z-popover)] tw:[width:max(260px,var(--reka-combobox-trigger-width,_260px))] tw:[max-width:calc(100vw_-_24px)] tw:[max-height:var(--reka-combobox-content-available-height,_320px)] tw:overflow-hidden tw:p-s-2 tw:border tw:border-solid tw:border-soft tw:rounded-xl tw:bg-surface tw:shadow-(--shadow-lg) tw:text-primary" :aria-label="label">
        <div class="studio-combobox-heading tw:flex tw:justify-between tw:gap-s-3 tw:p-s-2 tw:mb-s-1 tw:[border-bottom:1px_solid_var(--border-soft)] tw:[font:600_var(--fs-label-sm)/var(--lh-body)_var(--font-sans)]" aria-hidden="true">{{ label }}<span class="tw:font-normal tw:text-muted">输入名称快速查找</span></div>
        <ComboboxViewport class="studio-combobox-viewport tw:[max-height:min(300px,calc(var(--reka-combobox-content-available-height,_320px)_-_64px))] tw:overflow-y-auto tw:overscroll-contain tw:[scrollbar-width:thin]">
          <ComboboxEmpty class="studio-combobox-empty tw:py-s-5 tw:px-s-3 tw:text-secondary tw:text-label tw:text-center">没有匹配项，试试其他名字</ComboboxEmpty>
          <ComboboxItem v-for="option in options" :key="option.value" :value="option.value"
            :text-value="option.label" class="studio-combobox-option tw:flex tw:items-center tw:justify-between tw:gap-s-3 tw:min-h-[40px] tw:py-s-2 tw:px-s-3 tw:rounded-md tw:[font:500_var(--fs-label)/var(--lh-body)_var(--font-sans)] tw:cursor-pointer tw:[overflow-wrap:anywhere]">
            <span>{{ option.label }}</span>
            <ComboboxItemIndicator class="studio-combobox-check tw:flex tw:shrink-0 tw:text-accent"><ArchiveIcon name="success" /></ComboboxItemIndicator>
          </ComboboxItem>
        </ComboboxViewport>
      </ComboboxContent>
    </ComboboxPortal>
  </ComboboxRoot>
</template>

<!-- Reka portals cross component roots; keep these uniquely prefixed rules global. -->
<style>
.studio-combobox-anchor:focus-within { outline:2px solid var(--accent); outline-offset:2px; }
/* One focus ring surrounds the whole field, including its disclosure button. */
.studio-combobox .studio-combobox-anchor .studio-combobox-input:focus-visible { outline:none; }
.studio-combobox-input::placeholder { color:var(--text-muted); }
.studio-combobox-trigger:hover { background:var(--bg-hover); }
.studio-combobox-trigger:focus-visible { outline:2px solid var(--accent); outline-offset:-3px; }
.studio-combobox-trigger .archive-icon { width:16px; height:16px; transition:transform var(--motion-hover); }
.studio-combobox-trigger[data-state='open'] .archive-icon { transform:rotate(180deg); }
.studio-combobox-input:disabled, .studio-combobox-trigger:disabled { color:var(--text-disabled); cursor:not-allowed; }
.studio-combobox-option[data-state='checked'] { background:var(--accent-soft); color:var(--accent); }
.studio-combobox-option[data-highlighted] { outline:1px solid var(--accent); outline-offset:-1px; background:var(--bg-hover); }
.studio-combobox-check .archive-icon { width:16px; height:16px; }
@media(max-width:600px) { .studio-combobox-anchor,.studio-combobox-option { min-height:44px; } }
@media(prefers-reduced-motion:reduce) { .studio-combobox-trigger .archive-icon { transition:none; } }
@media(forced-colors:active) { .studio-combobox-content { background:Canvas; border-color:CanvasText; } .studio-combobox-option[data-state='checked'] { outline:1px solid Highlight; outline-offset:-1px; } }
</style>
