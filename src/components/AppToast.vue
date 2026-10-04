<template>
  <Teleport to="body">
    <!-- 只在容器上声明一次 live region。子项再挂 role="status" 会造成
         嵌套 live region，读屏可能重复播报或整条丢掉。 -->
    <div
      ref="stackEl"
      class="toast-stack"
      :class="{ 'toast-stack-on-left': placement === 'bottom-left' }"
      aria-live="polite"
      aria-atomic="false"
      @mouseenter="pauseAll('hover')"
      @mouseleave="resumeAll('hover')"
      @focusin="pauseAll('focus')"
      @focusout="onFocusOut"
    >
      <TransitionGroup :css="false" @enter="onToastEnter" @leave="onToastLeave">
        <div
          v-for="t in toasts"
          :key="t.id"
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
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { animateMini } from 'motion'
import { nextTick, onMounted, onUnmounted, ref } from 'vue'
import { prefersReducedMotion } from '@/utils/motionPreference'
import ArchiveIcon, { type ArchiveIconName } from '@/components/visual/ArchiveIcon.vue'
import { useToast, type ToastItem, type ToastType } from '@/composables/useToast'

const { toasts, dismiss, pauseAll, resumeAll } = useToast()
withDefaults(defineProps<{ placement?: 'bottom-left' | 'bottom-right' }>(), { placement: 'bottom-right' })
const stackEl = ref<HTMLElement | null>(null)

function onFocusOut(event: FocusEvent) {
  if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) resumeAll('focus')
}
function dismissNotice(id: number, event: MouseEvent) {
  // Keyboard dismissal is immediate; repeated commands do not wait for motion.
  if (!event.detail) (event.currentTarget as HTMLElement).closest<HTMLElement>('.toast-item')?.setAttribute('data-instant-leave', '')
  dismiss(id)
}

function runAction(t: ToastItem, event: MouseEvent) {
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
  startY: number
  lastY: number
  lastTime: number
  velocity: number
  transform: string
  opacity: number
  el: HTMLElement
}

let activeDrag: DragSession | null = null
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
  motions.clear(); releaseDrag(); resumeAll('hover'); resumeAll('focus')
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
    startY: e.clientY,
    lastY: e.clientY,
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
  activeDrag.velocity = (e.clientY - activeDrag.lastY) / Math.max(1, now - activeDrag.lastTime)
  activeDrag.lastY = e.clientY
  activeDrag.lastTime = now
  const deltaY = Math.max(0, e.clientY - activeDrag.startY) // 仅允许向下滑出
  activeDrag.el.style.transform = prefersReducedMotion() ? '' : `translateY(${deltaY}px) ${activeDrag.transform}`
  activeDrag.el.style.opacity = String(activeDrag.opacity * Math.max(0.2, 1 - deltaY / 120))
}

function onPointerUp(e: PointerEvent, id: number) {
  if (!activeDrag || e.pointerId !== activeDrag.pointerId || id !== activeDrag.id) return
  const now = performance.now()
  const deltaY = e.clientY - activeDrag.startY
  const velocity = now - activeDrag.lastTime > 80 ? 0 : e.clientY === activeDrag.lastY
    ? activeDrag.velocity : (e.clientY - activeDrag.lastY) / Math.max(1, now - activeDrag.lastTime)
  const el = activeDrag.el
  releaseDrag()
  stopMotion(el)

  // 向下滑动超过 32px 或滑动速度超过 0.12 px/ms 则顺势消除
  if (deltaY > 32 || (deltaY > 0 && velocity > 0.12)) {
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
  const element = el as HTMLElement
  const interrupted = motions.has(element)
  stopMotion(element)
  const reduced = prefersReducedMotion()
  if (!interrupted) { element.style.opacity = '0'; element.style.transform = reduced ? '' : 'translateY(10px) scale(.98)' }
  const t = animateMini(element, reduced ? { opacity: 1 } : { opacity: 1, transform: 'translateY(0) scale(1)' }, { duration: reduced ? 0.12 : 0.22, ease: EASE_OUT })
  track(element, t, 1, done, done)
}

function onToastLeave(el: Element, done: () => void) {
  const element = el as HTMLElement
  if (activeDrag?.el === element) releaseDrag()
  stopMotion(element)
  const reduced = prefersReducedMotion()
  const finish = () => {
    done()
    void nextTick(() => {
      // Removing a focused close/action button need not emit focusout.
      if (!stackEl.value?.contains(document.activeElement)) resumeAll('focus')
    })
  }
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
  @apply tw:flex tw:flex-col-reverse tw:items-stretch tw:gap-s-2 tw:pointer-events-none;
}

.toast-item {
  @apply tw:flex tw:items-center tw:gap-s-3;
  padding: var(--s-3);
  @apply tw:rounded-lg;
  border: 1px solid var(--border-soft);
  background: var(--bg-surface);
  box-shadow: var(--shadow-md);
  @apply tw:text-body-sm tw:font-semibold tw:text-primary tw:pointer-events-auto tw:cursor-grab tw:select-none;
  touch-action: none;
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
.toast-action:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.toast-close { @apply tw:grid; place-items:center; @apply tw:min-w-[32px] tw:min-h-[32px] tw:rounded-md tw:shrink-0; background:none; border:none; @apply tw:text-secondary tw:cursor-pointer tw:p-s-1; font-size:.9em; @apply tw:leading-flush; }
.toast-close:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; @apply tw:rounded-sm; }

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
