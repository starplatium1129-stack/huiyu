<!-- Lucian UX/UI Prompt #001 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#001 -->
<script setup lang="ts">
import { onDeactivated, onScopeDispose, ref, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { useMotionPreference } from '@/composables/useMotionPreference'

const props = defineProps<{ label: string; busy: boolean; complete: boolean; disabled?: boolean }>()
const reduced = useMotionPreference()
const shownComplete = ref(false), glint = ref<HTMLElement | null>(null)
let timer: ReturnType<typeof setTimeout> | undefined
let bounds: DOMRect | undefined
function clear() { clearTimeout(timer); shownComplete.value = false; leave() }
function leave() { bounds = undefined; if (glint.value) glint.value.style.transform = 'translate(-50%, -50%)' }
function enter(event: PointerEvent) { if (event.pointerType === 'mouse' && !reduced.value) bounds = (event.currentTarget as HTMLElement).getBoundingClientRect() }
function move(event: PointerEvent) {
  if (!bounds || !glint.value || reduced.value) return
  glint.value.style.transform = `translate(${event.clientX - bounds.left - 65}px, ${event.clientY - bounds.top - 35}px)`
}
watch([() => props.busy, () => props.complete], ([busy, complete]) => {
  clear()
  if (!busy && complete) { shownComplete.value = true; timer = setTimeout(() => { shownComplete.value = false }, 3600) }
})
watch(reduced, leave)
onDeactivated(clear)
onScopeDispose(clear)
</script>

<template>
  <button class="u001" type="button" :data-loading="busy" :data-complete="shownComplete" :data-reduced-motion="reduced" :disabled="disabled || busy" :aria-busy="busy" :aria-label="busy ? '正在保存配置' : label" @pointerenter="enter" @pointermove="move" @pointerleave="leave">
    <span class="u001-surface" aria-hidden="true"><span class="u001-middle" /><span class="u001-cap u001-left" /><span class="u001-cap u001-right" /></span>
    <span class="u001-highlight" aria-hidden="true"><i ref="glint" /></span>
    <span class="u001-sheen" aria-hidden="true" />
    <span class="u001-text">{{ label }}</span>
    <span class="u001-spinner" aria-hidden="true"><ArchiveIcon name="refresh" /></span>
    <span class="u001-done" aria-hidden="true"><ArchiveIcon name="success" />配置已保存</span>
    <span class="u001-live" role="status">{{ shownComplete ? '配置已保存' : busy ? '正在保存配置' : '' }}</span>
  </button>
</template>

<style scoped>
.u001 { --ux-ease:var(--ease-out); --ux-spring:var(--ease-out); position:relative; display:block; width:200px; max-width:100%; height:48px; padding:0; border:0; border-radius:var(--r-md); background:transparent; color:var(--text-primary); font:600 var(--fs-label) var(--font-sans); cursor:pointer; isolation:isolate; -webkit-backdrop-filter:blur(18px) saturate(180%); backdrop-filter:blur(18px) saturate(180%); }
.u001-surface,.u001-highlight,.u001-text,.u001-done { position:absolute; inset:0; pointer-events:none; }
.u001-middle,.u001-cap::before { position:absolute; top:0; bottom:0; background:linear-gradient(180deg,var(--glass-highlight),transparent 55%,var(--glass-highlight)),var(--glass-fill); box-shadow:inset 0 1px 0 var(--glass-highlight),inset 0 0 0 1px var(--border-strong); }
.u001-surface { transition:transform var(--motion-press) var(--ux-ease); }
.u001:active:not(:disabled) .u001-surface { transform:scale(.97); }
.u001-middle { left:24px; right:24px; z-index:1; box-shadow:inset 0 1px 0 var(--border-strong),inset 0 -1px 0 var(--border-strong); transition:transform var(--motion-surface) var(--ux-ease); }
.u001-cap { position:absolute; inset:0; transition:transform var(--motion-surface) var(--ux-ease); }
.u001-cap::before { content:''; width:48px; border-radius:var(--r-md); }
.u001-left::before { left:0; }
.u001-right::before { right:0; }
.u001-highlight { overflow:hidden; border-radius:inherit; opacity:0; transition:opacity var(--motion-hover) var(--ux-ease); }
.u001-highlight i { position:absolute; width:130px; height:70px; left:0; top:0; background:radial-gradient(ellipse,var(--glass-highlight),transparent 70%); transform:translate(-50%,-50%); }
.u001-sheen { position:absolute; top:4px; bottom:4px; left:0; width:38%; border-radius:inherit; pointer-events:none; background:linear-gradient(100deg,transparent,var(--glass-highlight) 50%,transparent); transform:translateX(-150%) skewX(-12deg); }
.u001-text,.u001-done { display:flex; align-items:center; justify-content:center; gap:10px; white-space:nowrap; transition:opacity var(--motion-hover) var(--ux-ease),transform var(--motion-surface) var(--ux-ease); }
/* The ink remains on an opaque surface above the moving light. */
.u001-text { z-index:1; }
.u001-done { z-index:1; opacity:0; transform:translateY(14px); color:var(--success-text); }
.u001-done .archive-icon { width:24px; height:24px; }
.u001-spinner { position:absolute; left:50%; top:50%; width:30px; height:30px; margin:-15px 0 0 -15px; opacity:0; transform:scale(.5); transition:opacity var(--motion-hover) var(--ux-ease),transform var(--motion-surface) var(--ux-ease); }
.u001-spinner .archive-icon { width:100%; height:100%; }
.u001[data-loading='true'] .u001-left { transform:translateX(calc(50% - 24px)); }
.u001[data-loading='true'] .u001-right { transform:translateX(calc(24px - 50%)); }
.u001[data-loading='true'] .u001-middle { transform:scaleX(0); }
.u001[data-loading='true'] .u001-text,.u001[data-complete='true'] .u001-text { opacity:0; transform:translateY(-14px); }
.u001[data-loading='true'] .u001-spinner { opacity:1; transform:none; }
.u001[data-loading='true'] .u001-spinner .archive-icon { animation:u001-rotate 1s linear infinite; }
.u001[data-complete='true'] .u001-done { opacity:1; transform:none; }
.u001:disabled { color:var(--text-disabled); cursor:not-allowed; }
.u001[data-loading='true'] { cursor:progress; }
.u001:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
.u001-live { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
@media (hover:hover) and (pointer:fine) {
  .u001:hover:not(:disabled) .u001-highlight { opacity:1; }
  .u001:hover:not(:disabled) .u001-sheen { animation:u001-sweep 1.1s var(--ux-ease); }
}
@keyframes u001-rotate { to { transform:rotate(360deg); } }
@keyframes u001-sweep { to { transform:translateX(300%) skewX(-12deg); } }
.u001[data-reduced-motion='true'] * { animation:none !important; transition:none !important; }
:root:is([data-reduced-glass='true'],[data-theme-style='terraria']) .u001 { -webkit-backdrop-filter:none; backdrop-filter:none; --glass-fill:var(--bg-elevated); }
@media (prefers-reduced-transparency:reduce), (prefers-contrast:more), (forced-colors:active) {
  .u001 { -webkit-backdrop-filter:none; backdrop-filter:none; --glass-fill:var(--bg-elevated); }
}
</style>
