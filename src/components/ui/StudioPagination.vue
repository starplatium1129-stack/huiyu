<!-- Lucian UX/UI Prompt #043 · MIT (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#043 -->
<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
const props = withDefaults(defineProps<{ modelValue: number; pages: number; label: string; disabled?: boolean }>(), { disabled: false })
const emit = defineEmits<{ 'update:modelValue': [value: number] }>()
const numbers = ref<HTMLElement | null>(null)
const pageItems = computed(() => {
  if (props.pages <= 5) return Array.from({ length: props.pages }, (_, index) => index + 1)
  const middle = Math.max(3, Math.min(props.pages - 2, props.modelValue))
  const selected = new Set([1, middle - 1, middle, middle + 1, props.pages])
  const items: (number | string)[] = []
  for (const page of [...selected].sort((a, b) => a - b)) {
    const previous = items.at(-1)
    if (typeof previous === 'number' && page > previous + 1) items.push(`gap-${page}`)
    items.push(page)
  }
  return items
})
function select(value: number) {
  if (props.disabled || value < 1 || value > props.pages || value === props.modelValue) return
  emit('update:modelValue', value)
}
async function keyboard(event: KeyboardEvent) {
  const host = event.currentTarget as HTMLElement
  if (event.altKey || event.ctrlKey || event.metaKey || props.disabled) return
  const previous = getComputedStyle(host).direction === 'rtl' ? 'ArrowRight' : 'ArrowLeft'
  const next = previous === 'ArrowRight' ? 'ArrowLeft' : 'ArrowRight'
  if (![previous, next, 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const value = event.key === 'Home' ? 1 : event.key === 'End' ? props.pages : Math.max(1, Math.min(props.pages, props.modelValue + (event.key === previous ? -1 : 1)))
  select(value)
  await nextTick()
  // Some consumers intentionally move focus to their results after changing a page.
  if (document.activeElement === document.body || host.contains(document.activeElement)) numbers.value?.querySelector<HTMLButtonElement>(`[data-page="${value}"]`)?.focus({ preventScroll: true })
}
</script>
<template>
  <nav class="studio-pagination" :aria-label="label" @keydown="keyboard">
    <button class="page-arrow" type="button" aria-label="上一页" :aria-disabled="disabled || modelValue <= 1" @click="select(modelValue - 1)"><ArchiveIcon name="chevron-down" /></button>
    <div ref="numbers" class="page-numbers studio-segments studio-segments--compact" role="group" :aria-label="label + '页码'" data-segment-keyboard="managed">
      <AnimatedSelection stretch target=":scope > [aria-current='page']" />
      <template v-for="item in pageItems" :key="item">
        <button v-if="typeof item === 'number'" type="button" :data-page="item" :aria-label="`第 ${item} 页`" :aria-current="item === modelValue ? 'page' : undefined" :aria-disabled="disabled || undefined" @click="select(item)">{{ item }}</button>
        <span v-else class="page-gap" aria-hidden="true">…</span>
      </template>
    </div>
    <button class="page-arrow page-next" type="button" aria-label="下一页" :aria-disabled="disabled || modelValue >= pages" @click="select(modelValue + 1)"><ArchiveIcon name="chevron-down" /></button>
    <span class="page-status sr-only" role="status">第 {{ modelValue }} / {{ pages }} 页</span>
  </nav>
</template>
<style scoped>
.studio-pagination { display:flex; align-items:center; justify-content:center; gap:var(--s-2); max-width:100%; color:var(--text-secondary); font-size:var(--fs-label-sm); font-variant-numeric:tabular-nums; }
.page-arrow { display:grid; place-items:center; flex-shrink:0; width:36px; height:36px; padding:0; border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--bg-surface); color:var(--text-secondary); cursor:pointer; }
.page-arrow .archive-icon { width:16px; height:16px; transform:rotate(90deg); }
.page-next .archive-icon { transform:rotate(-90deg); }
.page-arrow:hover:not([aria-disabled='true']) { color:var(--text-primary); background:transparent; }
.studio-pagination button[aria-disabled='true'] { color:var(--text-disabled); cursor:default; }
.page-arrow:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
.page-numbers { min-width:0; flex-wrap:wrap; }
html body .page-numbers[role] { gap:0; padding:2px; border-radius:var(--r-md); --selection-radius:var(--r-sm); }
html body .page-numbers[role] > button { flex:0 0 auto; min-width:32px; min-height:32px; padding:var(--s-1); font:inherit; }
.page-gap { display:grid; place-items:center; min-width:12px; }
@media (forced-colors:active) { .page-arrow:focus-visible { outline:2px solid Highlight; } }
</style>
