<!-- Adapted from Lucian UX/UI Prompt #002 · MIT (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#002 -->
<script setup lang="ts">
import { onDeactivated, onScopeDispose, ref, watch } from 'vue'
import type { RouteLocationRaw } from 'vue-router'
import ArchiveIcon, { type ArchiveIconName } from '@/components/visual/ArchiveIcon.vue'
import { useMotionPreference } from '@/composables/useMotionPreference'

defineProps<{ to: RouteLocationRaw; label: string; icon: ArchiveIconName }>()
const reduced = useMotionPreference()
const arrow = ref<HTMLElement | null>(null)
let bounds: DOMRect | undefined
let transform = '', paintFrame = 0
function paint() { paintFrame = 0; if (bounds && arrow.value) arrow.value.style.transform = transform }
function reset() {
  bounds = undefined
  cancelAnimationFrame(paintFrame); paintFrame = 0
  if (arrow.value) arrow.value.style.transform = ''
  document.removeEventListener('scroll', reset, true)
  document.removeEventListener('keydown', reset, true)
  document.removeEventListener('visibilitychange', reset)
  window.removeEventListener('resize', reset)
  window.removeEventListener('blur', reset)
}
function enter(event: PointerEvent) {
  reset()
  if (event.pointerType === 'mouse' && !document.hidden && !reduced.value && matchMedia('(hover: hover) and (pointer: fine)').matches) {
    bounds = (event.currentTarget as HTMLElement).getBoundingClientRect()
    document.addEventListener('scroll', reset, { capture: true, passive: true })
    document.addEventListener('keydown', reset, true)
    document.addEventListener('visibilitychange', reset)
    window.addEventListener('resize', reset)
    window.addEventListener('blur', reset)
  }
}
function move(event: PointerEvent) {
  if (!bounds || event.pointerType !== 'mouse' || reduced.value) return
  const x = Math.max(-3, Math.min(3, (event.clientX - bounds.left - bounds.width / 2) * .05))
  const y = Math.max(-2, Math.min(2, (event.clientY - bounds.top - bounds.height / 2) * .08))
  transform = `translate(${x}px, ${y}px)`
  if (!paintFrame) paintFrame = requestAnimationFrame(paint)
}
watch(reduced, reset)
onDeactivated(reset)
onScopeDispose(reset)
</script>

<template>
  <RouterLink :to="to" class="btn btn-lg studio-action-link" :data-reduced-motion="reduced"
    @pointerenter="enter" @pointermove="move" @pointerleave="reset" @pointercancel="reset" @focus="reset">
    <span class="action-link-label"><ArchiveIcon :name="icon" />{{ label }}</span>
    <span ref="arrow" class="action-link-arrow" aria-hidden="true">
      <span class="action-link-arrow-track"><ArchiveIcon name="chevron-down" /><ArchiveIcon name="chevron-down" /></span>
    </span>
  </RouterLink>
</template>

<style scoped>
.studio-action-link { justify-content:space-between; gap:var(--s-4); padding-inline:var(--s-4) var(--s-3); }
/* Keep the link and focus ring stationary; only the inner arrow follows input. */
:root .studio-action-link:is(:hover,:active) { transform:none; }
:root[data-theme-style='terraria'] body .studio-action-link:is(:hover,:active) { transform:none; }
.action-link-label { display:inline-flex; align-items:center; gap:var(--s-2); transition:transform var(--motion-press) var(--ease-out); }
.action-link-label > .archive-icon { width:18px; height:18px; }
.action-link-arrow { display:grid; place-items:center; flex:none; width:28px; height:28px; border-radius:50%; background:color-mix(in srgb,currentColor 12%,transparent); transition:transform var(--motion-control) var(--ease-out); }
.action-link-arrow-track { position:relative; display:block; width:18px; height:18px; overflow:hidden; }
.action-link-arrow-track .archive-icon { position:absolute; inset:0; width:18px; height:18px; transform:rotate(-90deg); transition:transform var(--motion-control) var(--ease-out),opacity var(--motion-hover) var(--ease-out); }
.action-link-arrow-track .archive-icon + .archive-icon { transform:translateX(-125%) rotate(-90deg); opacity:0; }
@media (hover:hover) and (pointer:fine) {
  .studio-action-link:hover .action-link-arrow-track .archive-icon:first-child { transform:translateX(125%) rotate(-90deg); opacity:0; }
  .studio-action-link:hover .action-link-arrow-track .archive-icon + .archive-icon { transform:rotate(-90deg); opacity:1; }
  .studio-action-link:active .action-link-label { transform:scale(.98); }
}
.studio-action-link:focus-visible .action-link-arrow,
.studio-action-link:focus-visible .action-link-label { transition:none; transform:none; }
.studio-action-link[data-reduced-motion='true'] .action-link-arrow,
.studio-action-link[data-reduced-motion='true'] .action-link-label { transition:none; transform:none; }
.studio-action-link[data-reduced-motion='true'] .action-link-arrow-track .archive-icon { transition:none; transform:rotate(-90deg); }
.studio-action-link[data-reduced-motion='true'] .action-link-arrow-track .archive-icon:first-child { transform:rotate(-90deg); opacity:1; }
.studio-action-link[data-reduced-motion='true'] .action-link-arrow-track .archive-icon + .archive-icon { transform:rotate(-90deg); opacity:0; }
@media (forced-colors:active) { .action-link-arrow { outline:1px solid ButtonText; } }
</style>
