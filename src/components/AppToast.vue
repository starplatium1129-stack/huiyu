<template>
  <Teleport to="body">
    <!-- A single announcement owner avoids re-reading old notices on expansion. -->
    <span class="sr-only" aria-live="polite" aria-atomic="true"><span :key="announcement.id">{{ announcement.msg }}</span></span>
    <div
      ref="stackEl"
      class="toast-stack"
      :class="{ 'toast-stack-on-left': placement === 'bottom-left' }"
      :data-expanded="expanded" :data-reduced-motion="reduced"
      :data-has-notices="toasts.length > 0"
      role="region" aria-label="提示"
      @pointerenter="enter" @pointerleave="leave"
      @focusin="expanded = true" @focusout="onStackFocusOut"
    >
      <button v-if="toasts.length > 1" class="toast-expand" type="button" :aria-expanded="expanded" @click="expanded = true">查看 {{ toasts.length }} 条提示<ArchiveIcon name="chevron-down" /></button>
      <TransitionGroup tag="div" class="toast-list" move-class="toast-move-disabled" :style="{ height: stackHeight + 'px' }" :css="false" @enter="onToastEnter" @leave="onToastLeave">
        <div
          v-for="t in toasts"
          :key="t.id"
          :ref="el => bindSlot(el, t.id)" :data-toast-id="t.id"
          class="toast-slot" :style="slotStyle(t.id)" :inert="hidden(t.id)"
        >
        <div
          class="toast-item"
          :class="`toast-${t.type}`"
          @pointerdown="onPointerDown($event, t.id)"
          @pointermove="onPointerMove($event)"
          @pointerup="onPointerUp($event, t.id)"
          @pointercancel="onPointerCancel($event)"
          @lostpointercapture="onPointerCancel($event)"
        >
          <span class="toast-icon" aria-hidden="true"><ArchiveIcon :name="icons[t.type]" /></span>
          <span class="toast-msg">{{ t.msg }}</span>
          <!-- 内联动作（如删除后的「撤销」）：点击即关 toast 并执行回调 -->
          <button
            v-if="t.action"
            class="toast-action"
            type="button"
            @click.stop="runAction(t, $event)"
          >{{ t.action.label }}</button>
          <!-- 关闭动作挂在按钮本身，而不是外层 div -->
          <button
            class="toast-close"
            type="button"
            :aria-label="`关闭提示：${t.msg}`"
            @click.stop="dismissNotice(t.id, $event)"
          ><ArchiveIcon name="close" /></button>
        </div>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { animateMini } from 'motion'
import { onMounted, onUnmounted, ref } from 'vue'
import { prefersReducedMotion } from '@/utils/motionPreference'
import ArchiveIcon, { type ArchiveIconName } from '@/components/visual/ArchiveIcon.vue'
import { useToast, type ToastItem, type ToastType } from '@/composables/useToast'
import { useToastStack } from '@/composables/useToastStack'

const { toasts, dismiss, pauseAll, resumeAll } = useToast()
withDefaults(defineProps<{ placement?: 'bottom-left' | 'bottom-right' }>(), { placement: 'bottom-right' })
const stackEl = ref<HTMLElement | null>(null)
const { expanded, reduced, announcement, stackHeight, bindSlot, slotStyle, hidden, enter, leave, focusOut: onStackFocusOut } = useToastStack(stackEl)

function dismissNotice(id: number, event: MouseEvent) {
  // Keyboard dismissal is immediate; repeated commands do not wait for motion.
  if (!event.detail) (event.currentTarget as HTMLElement).closest<HTMLElement>('.toast-item')?.setAttribute('data-instant-leave', '')
  dismiss(id)
}

function runAction(t: ToastItem, event: MouseEvent) {
  if (!toasts.value.some(item => item.id === t.id)) return
  dismissNotice(t.id, event)
  t.action?.onClick()
}

const icons: Record<ToastType, ArchiveIconName> = {
  info: 'info',
  success: 'success',
  error: 'error',
  warning: 'warning',
}

interface DragSession {
  id: number
  pointerId: number
  startX: number
  lastX: number
  lastTime: number
  velocity: number
  transform: string
  opacity: number
  el: HTMLElement
}

let activeDrag: DragSession | null = null
let dragFrame = 0
const motions = new Map<HTMLElement, { controls: ReturnType<typeof animateMini>; opacity: number; done: () => void; cancel: () => void }>()
const EASE_OUT = [0.23, 1, 0.32, 1] as const
function stopMotion(el: HTMLElement, finish = false) {
  const motion = motions.get(el)
  if (!motion) return
  motions.delete(el)
  // Motion's WAAPI stop commits the current presentation value before cancelling.
  motion.controls.stop()
  if (finish) {
    el.style.opacity = String(motion.opacity)
    el.style.transform = ''
    motion.done()
  } else motion.cancel()
}
function track(el: HTMLElement, controls: ReturnType<typeof animateMini>, opacity: number, done: () => void = () => {}, cancel: () => void = () => {}) {
  const motion = { controls, opacity, done, cancel }
  motions.set(el, motion)
  controls.then(() => { if (motions.get(el) === motion) stopMotion(el, true) })
}
function releaseDrag() {
  cancelAnimationFrame(dragFrame); dragFrame = 0
  if (!activeDrag) return
  const drag = activeDrag
  activeDrag = null
  try { drag.el.releasePointerCapture(drag.pointerId) } catch {}
  resumeAll('drag')
}
const motionMedia = matchMedia('(prefers-reduced-motion: reduce)')
function motionChanged() {
  if (!prefersReducedMotion()) return
  if (activeDrag) { activeDrag.el.style.transform = ''; activeDrag.el.style.opacity = ''; releaseDrag() }
  for (const el of [...motions.keys()]) stopMotion(el, true)
}
onMounted(() => { motionMedia.addEventListener('change', motionChanged); window.addEventListener('atelier:motion-preference', motionChanged) })
onUnmounted(() => {
  motionMedia.removeEventListener('change', motionChanged); window.removeEventListener('atelier:motion-preference', motionChanged)
  for (const motion of motions.values()) motion.controls.stop()
  motions.clear(); releaseDrag()
})

function onPointerDown(e: PointerEvent, id: number) {
  // 按钮保留自己的点击目标；父容器捕获指针会把 click 重定向到提示条。
  if (activeDrag || e.button !== 0 || (e.target as Element).closest('button, a, input, select, textarea')) return
  const el = e.currentTarget as HTMLElement
  stopMotion(el)
  const presentation = getComputedStyle(el)
  activeDrag = {
    id,
    pointerId: e.pointerId,
    startX: e.clientX,
    lastX: e.clientX,
    lastTime: performance.now(),
    velocity: 0,
    transform: presentation.transform === 'none' ? '' : presentation.transform,
    opacity: Number(presentation.opacity) || 1,
    el,
  }
  pauseAll('drag')
  el.setPointerCapture(e.pointerId)
}

function onPointerMove(e: PointerEvent) {
  if (!activeDrag || e.pointerId !== activeDrag.pointerId) return
  const now = performance.now()
  activeDrag.velocity = (e.clientX - activeDrag.lastX) / Math.max(1, now - activeDrag.lastTime)
  activeDrag.lastX = e.clientX
  activeDrag.lastTime = now
  if (!dragFrame) dragFrame = requestAnimationFrame(() => { dragFrame = 0; paintDrag() })
}

function paintDrag(clientX = activeDrag?.lastX) {
  if (!activeDrag || clientX === undefined) return
  const deltaX = clientX - activeDrag.startX
  activeDrag.el.style.transform = prefersReducedMotion() ? '' : `translateX(${deltaX}px) ${activeDrag.transform}`
  activeDrag.el.style.opacity = String(activeDrag.opacity * Math.max(0.2, 1 - Math.abs(deltaX) / 180))
}

function onPointerUp(e: PointerEvent, id: number) {
  if (!activeDrag || e.pointerId !== activeDrag.pointerId || id !== activeDrag.id) return
  const now = performance.now()
  const deltaX = e.clientX - activeDrag.startX
  const velocity = now - activeDrag.lastTime > 80 ? 0 : e.clientX === activeDrag.lastX
    ? activeDrag.velocity : (e.clientX - activeDrag.lastX) / Math.max(1, now - activeDrag.lastTime)
  const el = activeDrag.el
  paintDrag(e.clientX)
  releaseDrag()
  stopMotion(el)

  // Sideways swipes dismiss one notice; vertical scrolling remains available.
  if (Math.abs(deltaX) > 60 || (Math.abs(deltaX) > 8 && Math.abs(velocity) > 0.3)) {
    // The leave hook continues from this exact position; there is no second exit.
    dismiss(id)
  } else {
    // 未达阈值时从当前拖拽位置归位，reduced motion 仅保留淡回反馈。
    const reduced = prefersReducedMotion()
    if (reduced) {
      el.style.transform = ''
    }
    track(el, animateMini(
      el,
      reduced ? { opacity: 1 } : { opacity: 1, transform: 'translateY(0)' },
      { duration: reduced ? 0.12 : 0.18, ease: EASE_OUT },
    ), 1)
  }
}

function onPointerCancel(e: PointerEvent) {
  if (!activeDrag || e.pointerId !== activeDrag.pointerId) return
  const el = activeDrag.el
  releaseDrag()
  const reduced = prefersReducedMotion()
  if (reduced) el.style.transform = ''
  track(el, animateMini(el, reduced ? { opacity: 1 } : { opacity: 1, transform: 'translateY(0)' }, { duration: reduced ? 0.12 : 0.18, ease: EASE_OUT }), 1)
}

// Entry sets the initial pose once. Interruptions retain WAAPI's live values.
function onToastEnter(el: Element, done: () => void) {
  const element = el.firstElementChild as HTMLElement
  element.inert = false
  element.removeAttribute('aria-hidden')
  const interrupted = motions.has(element)
  stopMotion(element)
  const reduced = prefersReducedMotion()
  if (!interrupted) { element.style.opacity = '0'; element.style.transform = reduced ? '' : 'translateY(10px) scale(.98)' }
  const t = animateMini(element, reduced ? { opacity: 1 } : { opacity: 1, transform: 'translateY(0) scale(1)' }, { duration: reduced ? 0.12 : 0.22, ease: EASE_OUT })
  track(element, t, 1, done, done)
}

function onToastLeave(el: Element, done: () => void) {
  const slot = el as HTMLElement
  const element = slot.firstElementChild as HTMLElement
  slot.inert = true
  element.inert = true
  element.setAttribute('aria-hidden', 'true')
  if (activeDrag?.el === element) releaseDrag()
  stopMotion(element)
  const reduced = prefersReducedMotion()
  const finish = done
  if (element.hasAttribute('data-instant-leave')) { element.style.opacity = '0'; finish(); return }
  const t = animateMini(element, reduced ? { opacity: 0 } : { opacity: 0, transform: `translateY(10px) scale(.98) ${getComputedStyle(element).transform === 'none' ? '' : getComputedStyle(element).transform}` }, { duration: reduced ? 0.1 : 0.14, ease: EASE_OUT })
  track(element, t, 0, finish, finish)
}
</script>

<style scoped>
@reference "../assets/css/tailwind.css";

.toast-stack {
  @apply tw:fixed tw:bottom-s-6 tw:right-s-4 tw:left-auto;
  width: min(380px, calc(100vw - 2 * var(--s-4)));
  max-height: min(40dvh, 320px);
  @apply tw:overflow-y-auto;
  overscroll-behavior: contain;
  /* 走 z 阶梯。9999 会盖住 --z-skip(500) 的跳转链接 */
  z-index: var(--z-toast);
  @apply tw:flex tw:flex-col tw:items-stretch tw:gap-s-2 tw:pointer-events-none;
  padding:4px;
}
.toast-list { position:relative; flex-shrink:0; }
/* The gaps belong to the same hover surface as the cards. Otherwise moving
   cards expose the page, repeatedly firing leave/enter under a still pointer. */
.toast-stack[data-has-notices='true'] { pointer-events:auto; }
.toast-slot { position:absolute; inset:auto 0 0; transform-origin:50% 100%; transition:transform var(--motion-surface) var(--ease-out),opacity var(--motion-hover) var(--ease-out); }
/* Disable Vue's automatic FLIP pass: stack geometry already owns this transform. */
.toast-move-disabled { transition:none !important; }
.toast-item > * { transition:opacity var(--motion-hover) var(--ease-out); }
.toast-stack[data-expanded='false'] .toast-slot[inert] .toast-item > * { opacity:0; }
.toast-expand { display:flex; align-items:center; justify-content:center; gap:var(--s-2); min-height:28px; flex-shrink:0; padding:var(--s-1) var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-sm); background:var(--bg-surface); color:var(--text-secondary); font:500 var(--fs-label-xs) var(--font-sans); pointer-events:auto; cursor:pointer; }
.toast-expand .archive-icon { width:14px; height:14px; transform:rotate(180deg); }
.toast-expand:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
.toast-stack[data-reduced-motion='true'] :is(.toast-slot,.toast-item > *) { transition:none; }

.toast-item {
  @apply tw:flex tw:items-center tw:gap-s-3;
  padding: var(--s-3);
  @apply tw:rounded-lg;
  border: 1px solid var(--border-soft);
  background: var(--bg-surface);
  box-shadow: var(--shadow-md);
  @apply tw:text-body-sm tw:font-semibold tw:text-primary tw:pointer-events-auto tw:cursor-grab tw:select-none;
  touch-action: pan-y;
  transform-origin: bottom right;
  max-width: min(460px, 90vw);
  @apply tw:whitespace-pre-wrap;
  word-break: break-word;
}
.toast-stack-on-left { left:var(--s-4); right:auto; }
.toast-stack-on-left .toast-item { transform-origin:bottom left; }
.toast-item:active { @apply tw:cursor-grabbing; }

.toast-icon { @apply tw:grid tw:w-[28px] tw:h-[28px] tw:rounded-md tw:shrink-0; place-items:center; font-size: 1em; background:var(--accent-soft); }
.toast-msg  { flex: 1; @apply tw:min-w-0 tw:leading-body; }
.toast-action {
  @apply tw:max-w-[45%] tw:whitespace-normal tw:shrink-0;
  border: 0;
  background: var(--accent-soft);
  @apply tw:text-accent;
  font: inherit;
  @apply tw:font-bold;
  min-height:32px;
  padding: var(--s-2) var(--s-3);
  @apply tw:rounded-md tw:cursor-pointer tw:leading-flush;
}
@media (hover: hover) and (pointer: fine) {
  .toast-action:hover { background:color-mix(in srgb, var(--accent) 18%, var(--bg-surface)); }
  .toast-close:hover { color:var(--text-primary); background:var(--bg-elevated); }
}
.toast-action:focus-visible { outline: none; box-shadow: var(--focus-shadow); }
.toast-close { @apply tw:grid; place-items:center; @apply tw:min-w-[32px] tw:min-h-[32px] tw:rounded-md tw:shrink-0; background:none; border:none; @apply tw:text-secondary tw:cursor-pointer tw:p-s-1; font-size:.9em; @apply tw:leading-flush; }
.toast-close:focus-visible { outline: none; box-shadow: var(--focus-shadow); @apply tw:rounded-sm; }

/* 图标是这四种提示唯一的颜色信号,按设计系统契约必须走 --*-text
   (原 token 是给色块/描边调的,浅色主题下当图标只有 1.9–2.6:1) */
.toast-success .toast-icon { background:color-mix(in srgb, var(--success) 12%, var(--bg-surface)); }
.toast-success .toast-icon { @apply tw:text-success-text; }
.toast-error .toast-icon { background:color-mix(in srgb, var(--danger) 10%, var(--bg-surface)); }
.toast-error   .toast-icon { @apply tw:text-danger-text; }
.toast-warning .toast-icon { background:color-mix(in srgb, var(--warning) 10%, var(--bg-surface)); }
.toast-warning .toast-icon { @apply tw:text-warning-text; }
.toast-info    .toast-icon { @apply tw:text-accent; }

/* TransitionGroup 进出由 Motion 的 WAAPI 接管，拖拽直接跟随指针。 */
</style>
