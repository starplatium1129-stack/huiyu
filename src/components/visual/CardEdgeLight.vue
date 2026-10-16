<template>
  <span ref="frame" class="card-edge-light" aria-hidden="true"><span ref="light" class="card-edge-light-dot" /></span>
</template>

<script setup lang="ts">
// Inspira UI CardSpotlight, adapted to a masked border and a prepainted moving light.
// https://github.com/unovue/inspira-ui/blob/04c57ab62b9713872ebbf68988dff1836ed3d764/app/components/inspira/ui/card-spotlight/CardSpotlight.vue
// MIT Copyright (c) 2024-2026 rahulv.dev; notice: assets/licenses/inspira-ui.txt.
import { onActivated, onDeactivated, onMounted, onScopeDispose, shallowRef } from 'vue'
import { listenMotionChanges, prefersReducedMotion } from '@/utils/motionPreference'

const frame = shallowRef<HTMLElement | null>(null)
const light = shallowRef<HTMLElement | null>(null)
let host: HTMLElement | null = null
let pending = 0, x = 0, y = 0, tracking = false
let release: (() => void) | undefined

function stop(event?: Event) {
  const next = (event as PointerEvent | undefined)?.relatedTarget
  if (event?.type === 'pointerleave' && next instanceof Node && host?.contains(next)) return
  tracking = false
  cancelAnimationFrame(pending); pending = 0
  if (frame.value) frame.value.style.opacity = '0'
  release?.(); release = undefined
  document.removeEventListener('keydown', stop, true)
  document.removeEventListener('scroll', stop, true)
  window.removeEventListener('resize', stop)
}
function move(event: PointerEvent) {
  if (!tracking || event.pointerType === 'touch') return
  x = event.clientX; y = event.clientY
  if (pending) return
  pending = requestAnimationFrame(() => {
    pending = 0
    if (!host?.isConnected || host.closest('[inert], [hidden]')) { stop(); return }
    const rect = host.getBoundingClientRect()
    if (light.value) light.value.style.transform = `translate(${x - rect.left}px, ${y - rect.top}px) translate(-50%, -50%)`
    if (frame.value) frame.value.style.opacity = '1'
  })
}
function enter(event: PointerEvent) {
  if (event.pointerType === 'touch' || document.hidden || prefersReducedMotion()
    || !matchMedia('(hover: hover) and (pointer: fine)').matches) return
  stop()
  tracking = true
  release = listenMotionChanges(() => { if (prefersReducedMotion() || document.hidden) stop() })
  document.addEventListener('keydown', stop, true)
  document.addEventListener('scroll', stop, true)
  window.addEventListener('resize', stop)
  move(event)
}
function bind() {
  if (host) return
  host = frame.value?.parentElement ?? null
  host?.addEventListener('pointerenter', enter, { passive: true })
  host?.addEventListener('pointermove', move, { passive: true })
  host?.addEventListener('pointerleave', stop)
  host?.addEventListener('pointercancel', stop)
}
function unbind() {
  stop()
  host?.removeEventListener('pointerenter', enter)
  host?.removeEventListener('pointermove', move)
  host?.removeEventListener('pointerleave', stop)
  host?.removeEventListener('pointercancel', stop)
  host = null
}
onMounted(bind)
onActivated(bind)
onDeactivated(unbind)
onScopeDispose(unbind)
</script>

<style>
/* Shared card-preview timing follows Sakuria: artwork settles after its card. */
:root { --motion-art-hover:700ms; }
</style>

<style scoped>
/* The static mask keeps light on the edge, clear of artwork and labels. */
.card-edge-light { display:none; position:absolute; inset:0; z-index:var(--z-raised); padding:1px; border-radius:inherit; pointer-events:none; opacity:0; transition:opacity var(--motion-hover) var(--ease-out); }
.card-edge-light-dot { position:absolute; top:0; left:0; width:200px; height:200px; background:radial-gradient(closest-side,var(--accent),transparent); }
@supports (mask-composite:exclude) {
  @media (hover:hover) and (pointer:fine) {
    .card-edge-light { display:block; mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0); mask-composite:exclude; }
  }
}
@media (prefers-reduced-motion:reduce) { :root:not([data-motion='full']) .card-edge-light { display:none; } }
:root:is([data-motion='reduce'],[data-motion='reduced']) .card-edge-light { display:none; }
@media (forced-colors:active) { .card-edge-light { display:none; } }
</style>
