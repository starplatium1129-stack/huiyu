<template>
  <Teleport to="body">
    <!-- 只在容器上声明一次 live region。子项再挂 role="status" 会造成
         嵌套 live region，读屏可能重复播报或整条丢掉。 -->
    <div
      ref="stackEl"
      class="toast-stack"
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
        >
          <span class="toast-icon" aria-hidden="true"><ArchiveIcon :name="icons[t.type]" /></span>
          <span class="toast-msg">{{ t.msg }}</span>
          <!-- 内联动作（如删除后的「撤销」）：点击即关 toast 并执行回调 -->
          <button
            v-if="t.action"
            class="toast-action"
            type="button"
            @click.stop="runAction(t)"
          >{{ t.action.label }}</button>
          <!-- 关闭动作挂在按钮本身，而不是外层 div -->
          <button
            class="toast-close"
            type="button"
            :aria-label="`关闭提示：${t.msg}`"
            @click.stop="dismiss(t.id)"
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
const stackEl = ref<HTMLElement | null>(null)

function onFocusOut(event: FocusEvent) {
  if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) resumeAll('focus')
}
onUnmounted(() => { resumeAll('hover'); resumeAll('focus') })

function runAction(t: ToastItem) {
  dismiss(t.id)
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
  startY: number
  lastY: number
  lastTime: number
  el: HTMLElement
}

let activeDrag: DragSession | null = null
const motions = new Map<HTMLElement, { controls: ReturnType<typeof animateMini>; opacity: number; done: () => void }>()
function settle(el: HTMLElement) {
  const motion = motions.get(el)
  if (!motion) return
  motions.delete(el)
  motion.controls.stop()
  el.style.opacity = String(motion.opacity)
  el.style.transform = ''
  motion.done()
}
function track(el: HTMLElement, controls: ReturnType<typeof animateMini>, opacity: number, done: () => void = () => {}) {
  const motion = { controls, opacity, done }
  motions.set(el, motion)
  controls.then(() => { if (motions.get(el) === motion) settle(el) })
}
const motionMedia = matchMedia('(prefers-reduced-motion: reduce)')
function motionChanged() {
  if (!prefersReducedMotion()) return
  if (activeDrag) { activeDrag.el.style.transform = ''; activeDrag.el.style.opacity = ''; activeDrag = null }
  for (const el of [...motions.keys()]) settle(el)
}
onMounted(() => { motionMedia.addEventListener('change', motionChanged); window.addEventListener('atelier:motion-preference', motionChanged) })
onUnmounted(() => {
  motionMedia.removeEventListener('change', motionChanged); window.removeEventListener('atelier:motion-preference', motionChanged)
  for (const motion of motions.values()) motion.controls.stop()
  motions.clear(); activeDrag = null
})

function onPointerDown(e: PointerEvent, id: number) {
  // 按钮保留自己的点击目标；父容器捕获指针会把 click 重定向到提示条。
  if ((e.target as Element).closest('button, a, input, select, textarea')) return
  const el = e.currentTarget as HTMLElement
  settle(el)
  activeDrag = {
    id,
    startY: e.clientY,
    lastY: e.clientY,
    lastTime: performance.now(),
    el,
  }
  el.setPointerCapture(e.pointerId)
}

function onPointerMove(e: PointerEvent) {
  if (!activeDrag) return
  const now = performance.now()
  activeDrag.lastY = e.clientY
  activeDrag.lastTime = now
  const deltaY = Math.max(0, e.clientY - activeDrag.startY) // 仅允许向下滑出
  activeDrag.el.style.transform = `translateY(${deltaY}px)`
  activeDrag.el.style.opacity = String(Math.max(0.2, 1 - deltaY / 120))
}

function onPointerUp(e: PointerEvent, id: number) {
  if (!activeDrag) return
  const now = performance.now()
  const deltaY = e.clientY - activeDrag.startY
  const elapsed = Math.max(1, now - activeDrag.lastTime)
  const velocity = (e.clientY - activeDrag.lastY) / elapsed // px/ms，向上回拖不视为下滑消除
  const el = activeDrag.el
  activeDrag = null
  settle(el)

  // 向下滑动超过 32px 或滑动速度超过 0.12 px/ms 则顺势消除
  if (deltaY > 32 || (deltaY > 0 && velocity > 0.12)) {
    const reduced = prefersReducedMotion()
    track(el, animateMini(el, reduced ? { opacity: 0 } : { opacity: 0, transform: `translateY(${deltaY + 24}px)` }, { duration: reduced ? 0 : 0.14 }), 0, () => dismiss(id))
  } else {
    // 未达阈值时从当前拖拽位置短促回弹，reduced motion 仅保留淡回反馈。
    const reduced = prefersReducedMotion()
    if (reduced) {
      el.style.transform = ''
    }
    track(el, animateMini(
      el,
      reduced ? { opacity: 1 } : { opacity: 1, transform: 'translateY(0)' },
      reduced ? { duration: 0 } : { type: 'spring', bounce: 0.12, duration: 0.22 },
    ), 1)
  }
}

function onPointerCancel(e: PointerEvent) {
  if (activeDrag) {
    activeDrag.el.style.transform = ''
    activeDrag.el.style.opacity = ''
    activeDrag = null
  }
}

// toast 进出走 spring：多个 toast 连续弹出时可互相打断、从当前值续走，
// 不会像固定时长 keyframes 那样排队撞墙。
function onToastEnter(el: Element, done: () => void) {
  settle(el as HTMLElement)
  const reduced = prefersReducedMotion()
  const t = reduced
    ? animateMini(el as HTMLElement, { opacity: [0, 1] }, { duration: 0 })
    : animateMini(
        el as HTMLElement,
        { opacity: [0, 1], transform: ['translateY(16px) scale(.97)', 'translateY(0) scale(1)'] },
        { type: 'spring', bounce: 0, duration: 0.38 },
      )
  track(el as HTMLElement, t, 1, done)
}

function onToastLeave(el: Element, done: () => void) {
  settle(el as HTMLElement)
  const reduced = prefersReducedMotion()
  const t = reduced
    ? animateMini(el as HTMLElement, { opacity: 0 }, { duration: 0 })
    : animateMini(
        el as HTMLElement,
        { opacity: 0, transform: 'translateY(-8px) scale(.96)' },
        { duration: 0.16, ease: 'easeOut' },
      )
  track(el as HTMLElement, t, 0, () => {
    done()
    void nextTick(() => {
      // Removing a focused close/action button need not emit focusout.
      if (!stackEl.value?.contains(document.activeElement)) resumeAll('focus')
    })
  })
}
</script>

<style scoped>
.toast-stack {
  position: fixed;
  bottom: var(--s-6);
  right: var(--s-4);
  left: auto;
  width: min(360px, calc(100vw - 2 * var(--s-4)));
  max-height: min(40dvh, 320px);
  overflow-y: auto;
  overscroll-behavior: contain;
  /* 走 z 阶梯。9999 会盖住 --z-skip(500) 的跳转链接 */
  z-index: var(--z-toast);
  display: flex;
  flex-direction: column-reverse;
  align-items: stretch;
  gap: var(--s-2);
  pointer-events: none;
}

.toast-item {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  padding: var(--s-3) var(--s-4);
  border-radius: var(--r-lg);
  border: 1px solid var(--border-soft);
  background: var(--bg-elevated);
  backdrop-filter: blur(16px);
  /* 走 token:硬编码 rgba 在浅色主题下是脏灰,而 --glass-shadow 已按主题调过 */
  box-shadow: var(--glass-shadow), 0 1px 0 var(--glass-highlight) inset;
  font-size: var(--fs-body-sm);
  font-weight: 600;
  color: var(--text-primary);
  pointer-events: auto;
  cursor: grab;
  user-select: none;
  touch-action: pan-y;
  max-width: min(460px, 90vw);
  white-space: pre-wrap;
  word-break: break-word;
  transition: box-shadow var(--motion-hover);
}
.toast-item:active { cursor: grabbing; }
.toast-item:hover {
  border-color: color-mix(in srgb, var(--accent) 35%, var(--border-soft));
}

.toast-icon { display:grid; place-items:center; font-size: 1em; flex-shrink: 0; }
.toast-msg  { flex: 1; min-width: 0; line-height: var(--lh-label); }
.toast-action {
  max-width: 45%;
  white-space: normal;
  flex-shrink: 0;
  border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border-soft));
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent);
  font: inherit;
  font-weight: 700;
  padding: var(--s-1) var(--s-3);
  border-radius: var(--r-md);
  cursor: pointer;
  line-height: var(--lh-flush);
  transition: background var(--motion-hover), border-color var(--motion-hover);
}
.toast-action:hover {
  background: color-mix(in srgb, var(--accent) 24%, transparent);
  border-color: color-mix(in srgb, var(--accent) 65%, var(--border-soft));
}
.toast-action:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.toast-close { display:grid; place-items:center; min-width:28px; min-height:28px; flex-shrink:0; background:none; border:none; color:var(--text-secondary); cursor:pointer; padding:var(--s-1); font-size:.9em; line-height:var(--lh-flush); }
.toast-close:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: var(--r-sm); }

/* 图标是这四种提示唯一的颜色信号,按设计系统契约必须走 --*-text
   (原 token 是给色块/描边调的,浅色主题下当图标只有 1.9–2.6:1) */
.toast-success { border-color: color-mix(in srgb, var(--success) 40%, var(--border-soft)); }
.toast-success .toast-icon { color: var(--success-text); }
.toast-error   { border-color: color-mix(in srgb, var(--danger)  40%, var(--border-soft)); }
.toast-error   .toast-icon { color: var(--danger-text); }
.toast-warning { border-color: color-mix(in srgb, var(--warning) 40%, var(--border-soft)); }
.toast-warning .toast-icon { color: var(--warning-text); }
.toast-info    .toast-icon { color: var(--accent); }

/* TransitionGroup 进出由 motion spring 接管，这里只留布局稳定类 */
</style>
