<template>
  <span ref="frame" class="card-edge-light" aria-hidden="true"><span ref="light" class="card-edge-light-dot" /></span>
</template>

<script lang="ts">
// Inspira UI CardSpotlight, adapted to a masked border and a prepainted moving light.
// https://github.com/unovue/inspira-ui/blob/04c57ab62b9713872ebbf68988dff1836ed3d764/app/components/inspira/ui/card-spotlight/CardSpotlight.vue
// MIT Copyright (c) 2024-2026 rahulv.dev; notice: assets/licenses/inspira-ui.txt.
import { cancelFrame, frame as motionFrame } from 'motion'
import { listenMotionChanges, prefersReducedMotion } from '@/utils/motionPreference'

interface CardLightEntry {
  frame: HTMLElement
  light: HTMLElement
}

const HOST_ATTR = 'data-card-edge-host'
const registry = new WeakMap<HTMLElement, CardLightEntry>()
let registeredCount = 0
let activeHost: HTMLElement | null = null
let activeEntry: CardLightEntry | null = null
let x = 0, y = 0, transform = ''
let releaseMotion: (() => void) | undefined
let fineHoverQuery: MediaQueryList | undefined

function supportsFineHover(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  fineHoverQuery ??= window.matchMedia('(hover: hover) and (pointer: fine)')
  return fineHoverQuery.matches
}

function stopActive() {
  cancelFrame(measure); cancelFrame(paint)
  if (activeEntry) activeEntry.frame.style.opacity = '0'
  activeHost = null
  activeEntry = null
  releaseMotion?.(); releaseMotion = undefined
  document.removeEventListener('pointermove', onPointerMove)
  document.removeEventListener('pointerout', onPointerOut)
  document.removeEventListener('pointercancel', stopActive)
  document.removeEventListener('keydown', stopActive, true)
  document.removeEventListener('scroll', stopActive, true)
  window.removeEventListener('resize', stopActive)
}

function measure() {
  if (!activeHost || !activeEntry || !activeHost.isConnected || activeHost.closest('[inert], [hidden]')) {
    stopActive(); return
  }
  const rect = activeHost.getBoundingClientRect()
  if (!rect.width || !rect.height) { stopActive(); return }
  transform = `translate(${x - rect.left}px, ${y - rect.top}px) translate(-50%, -50%)`
  motionFrame.render(paint)
}

function paint() {
  if (!activeEntry) return
  activeEntry.light.style.transform = transform
  activeEntry.frame.style.opacity = '1'
}

function onPointerMove(event: PointerEvent) {
  if (!activeHost || event.pointerType === 'touch') return
  x = event.clientX; y = event.clientY
  motionFrame.read(measure)
}

function onPointerOut(event: PointerEvent) {
  if (!activeHost) return
  const related = event.relatedTarget
  if (related instanceof Node && activeHost.contains(related)) return
  stopActive()
}

function onPointerOver(event: PointerEvent) {
  if (event.pointerType === 'touch' || document.hidden || prefersReducedMotion() || !supportsFineHover()) return
  const nextHost = event.target instanceof Element ? event.target.closest<HTMLElement>(`[${HOST_ATTR}]`) : null
  if (!nextHost) {
    if (activeHost) stopActive()
    return
  }
  const entry = registry.get(nextHost)
  if (!entry) return
  if (nextHost === activeHost) {
    onPointerMove(event)
    return
  }
  stopActive()
  activeHost = nextHost
  activeEntry = entry
  releaseMotion = listenMotionChanges(() => { if (prefersReducedMotion() || document.hidden) stopActive() })
  document.addEventListener('pointermove', onPointerMove, { passive: true })
  document.addEventListener('pointerout', onPointerOut, { passive: true })
  document.addEventListener('pointercancel', stopActive, { passive: true })
  document.addEventListener('keydown', stopActive, true)
  document.addEventListener('scroll', stopActive, true)
  window.addEventListener('resize', stopActive, { passive: true })
  onPointerMove(event)
}

function registerCard(host: HTMLElement, entry: CardLightEntry) {
  if (registry.has(host)) return
  registry.set(host, entry)
  host.setAttribute(HOST_ATTR, '')
  if (++registeredCount === 1) {
    document.addEventListener('pointerover', onPointerOver, { passive: true })
  }
}

function unregisterCard(host: HTMLElement) {
  if (!registry.delete(host)) return
  host.removeAttribute(HOST_ATTR)
  if (activeHost === host) stopActive()
  if (--registeredCount <= 0) {
    registeredCount = 0
    document.removeEventListener('pointerover', onPointerOver)
  }
}
</script>

<script setup lang="ts">
import { onActivated, onDeactivated, onMounted, onScopeDispose, shallowRef } from 'vue'

const frame = shallowRef<HTMLElement | null>(null)
const light = shallowRef<HTMLElement | null>(null)
let host: HTMLElement | null = null

function bind() {
  if (host || !frame.value || !light.value) return
  host = frame.value.parentElement
  if (host) registerCard(host, { frame: frame.value, light: light.value })
}
function unbind() {
  if (!host) return
  unregisterCard(host)
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
