import { onBeforeUnmount, onDeactivated, type Ref } from 'vue'
import { useFluidSurface } from './useFluidSurface'
import { prepareNativeModal } from './useFocusTrap'
import { acquirePageScrollLock } from '@/utils/pageScrollLock'
import { createDialogExit } from '@/utils/dialogExit'
import '@/assets/css/fluid-dialog.css'

/**
 * 模态弹窗打开期间锁定页面滚动。
 *
 * 原生 `dialog.showModal()` 只让背景 inert，并不阻止背景页面继续滚动，
 * 视口右侧的页面滚动条也会留在原地，弹窗与背景滚动的职责因此含混。
 * 用模块级计数锁支持「同时/连续打开多个弹窗」与「关闭中重开」；
 * 锁定时补偿滚动条宽度，避免页面在弹窗开合瞬间横向跳动。
 */
let modalLocks = 0
let releasePageScroll: (() => void) | undefined
let previousScrollX = 0
let previousScrollY = 0
let previousScrollPath = ''
let scrollRevision = 0
const scrollLocation = () => `${window.location.pathname}${window.location.search}${window.location.hash}`

function lockPageScroll() {
  scrollRevision++
  if (modalLocks++ > 0) return
  previousScrollX = window.scrollX
  previousScrollY = window.scrollY
  previousScrollPath = scrollLocation()
  releasePageScroll = acquirePageScrollLock()
}

function unlockPageScroll() {
  if (modalLocks === 0) return null
  modalLocks--
  scrollRevision++
  if (!modalLocks) {
    releasePageScroll?.(); releasePageScroll = undefined
  }
  const x = previousScrollX, y = previousScrollY, path = previousScrollPath, revision = scrollRevision
  const restore = () => {
    if (revision !== scrollRevision || scrollLocation() !== path) return
    // Coordinates can still match while native focus has queued smooth scrolling.
    // Cancel that pending trip too, including when another modal holds the lock.
    window.scrollTo({ left: x, top: y, behavior: 'instant' })
  }
  restore()
  // Correct before the first paint and once more after native focus tasks. Every
  // lock/unlock and full SPA location invalidates old corrections.
  if (typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(() => { restore(); window.requestAnimationFrame(restore) })
  }
  return restore
}

/** Native semantics close now; a leased picture carries the reversible exit. */
export function useFluidDialog(dialog: Ref<HTMLDialogElement | null>, imageMotion?: ReturnType<typeof useFluidSurface>) {
  const surface = imageMotion ?? useFluidSurface(undefined, { animatePanel: true })
  let locked = false
  let listenerTarget: HTMLDialogElement | null = null
  let returnFocus: HTMLElement | null = null
  let returnLocation = ''
  let restoreAfterClose: (() => void) | null = null
  let exit: ReturnType<typeof createDialogExit>
  /**
   * 原生 close 事件在本轮任务队列末尾派发。`close(() => open())` 这类同轮重开会在
   * 事件到达前重新 showModal，此时弹窗仍然是打开状态，旧事件不能把重开所需持有的
   * 滚动锁释放掉；只有确认当前没有打开的弹窗才解锁。
   */
  function onNativeClose() {
    if ((dialog.value ?? listenerTarget)?.open) return
    releaseScrollLock()
    const target = returnFocus
    returnFocus = null
    if (target?.isConnected && scrollLocation() === returnLocation && !target.closest('[inert], [hidden]')
      && (!modalLocks || target.closest('dialog[open]'))) target.focus({ preventScroll: true })
    // close() invokes this synchronously; the eventual native event may itself
    // follow another focus scroll, so repeat the guarded correction at that event.
    restoreAfterClose?.()
  }
  function trackClose(el: HTMLDialogElement) {
    if (listenerTarget === el) return
    listenerTarget?.removeEventListener('close', onNativeClose)
    el.addEventListener('close', onNativeClose)
    listenerTarget = el
  }
  function releaseScrollLock() {
    if (!locked) return
    locked = false
    restoreAfterClose = unlockPageScroll()
  }
  function open(source: HTMLElement | null = document.activeElement as HTMLElement | null) {
    const el = dialog.value
    if (!el) return
    restoreAfterClose = null
    el.setAttribute('data-fluid-dialog', '')
    if (!el.open) {
      returnFocus = source && source !== document.body ? source : null
      returnLocation = scrollLocation()
      const state = exit?.capture()
      exit?.cancel(); exit = undefined
      surface.dispose(el)
      // Native showModal can move focus and scroll; capture the reading position first.
      if (!locked) { locked = true; lockPageScroll() }
      prepareNativeModal(el)
      try { el.showModal() } catch (error) { releaseScrollLock(); throw error }
      // Measure after showModal: a closed native dialog has zero geometry.
      if (state) surface.adopt(el, state)
      // Native autofocus can queue smooth scrolling without changing the current
      // coordinates yet. Always cancel that trip before the first fade frame.
      window.scrollTo({ left: previousScrollX, top: previousScrollY, behavior: 'instant' })
      trackClose(el)
      // Centered native modals settle around their own center; anchored popovers
      // keep Reka's collision-aware origin in StudioPopover instead.
      el.style.transformOrigin = 'center center'
    }
    if (!locked) { locked = true; lockPageScroll() }
    surface.enter(el, () => {})
  }
  function close(after?: () => void) {
    const el = dialog.value
    if (!el?.open) { releaseScrollLock(); after?.(); return }
    exit?.cancel()
    exit = createDialogExit(el, surface.capture(el) ?? { value: 1, velocity: 0 }, surface)
    surface.dispose(el); el.style.transform = ''; el.style.opacity = ''
    el.close(); onNativeClose(); after?.()
  }
  function dispose() {
    returnFocus = null
    restoreAfterClose = null
    // 卸载时 Vue 会先把模板 ref 置空，这里回退到实际打开过的那个元素，
    // 否则会留下一个仍处于 open 状态的游离 dialog 和它的 close 监听。
    const el = dialog.value ?? listenerTarget
    if (listenerTarget) { listenerTarget.removeEventListener('close', onNativeClose); listenerTarget = null }
    if (el?.open) {
      exit?.cancel()
      exit = createDialogExit(el, surface.capture(el) ?? { value: 1, velocity: 0 }, surface)
      el.close()
    }
    if (el) surface.dispose(el)
    releaseScrollLock()
    restoreAfterClose = null
  }
  onDeactivated(() => { dispose(); exit?.cancel(); exit = undefined })
  onBeforeUnmount(dispose)
  return { open, close, dispose }
}

/**
 * 判定原生 `<dialog>` 的点击事件是否真正命中背景遮罩（`::backdrop`）。
 * 原生 `<dialog>` 的 padding/border/空白间隙点击时 `event.target` 也是 dialog 元素本身，
 * 必须比对客户端坐标与 boundingClientRect，只有在矩形外部才属于 backdrop。
 */
export function isBackdropClick(event: MouseEvent, dialog: HTMLElement | null): boolean {
  if (!dialog || event.target !== dialog) return false
  const rect = dialog.getBoundingClientRect()
  return (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  )
}
