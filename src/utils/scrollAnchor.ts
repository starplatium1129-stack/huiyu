/**
 * 有界的 window 滚动锚点。
 *
 * 布局突变（返回缓存页面、筛选把列表抽短）会让文档变矮，浏览器随即把滚动位置
 * 钳掉；等内容长回来时用户已经不在原来的位置了。这里把记录和恢复滚动位置的操作
 * 抽成一套原语，路由返回（F2.3）与场景库筛选（F3.2）共用，避免并存两份实现。
 *
 * 文档高度变化时才重新判断能否到达锚点，超时后回报实际落点。
 */

export interface ScrollAnchor {
  left: number
  top: number
}

export interface RestoreAnchorOptions {
  /** 调用方已完成 DOM 更新时可在绘制前恢复；默认下一帧，保留筛选前捕获的旧布局。 */
  immediate?: boolean
  /** 尝试恢复前询问，返回 false 时停止。 */
  shouldContinue?: () => boolean
  /** 等待文档长到能容纳锚点的上限 */
  timeoutMs?: number
  /** 真正落到锚点（文档已足够高）时回调 */
  onRestored?: () => void
  /** 超时仍未长到锚点高度时回调，参数是当时的实际滚动位置 */
  onAbandoned?: (currentTop: number) => void
}

const DEFAULT_TIMEOUT_MS = 1500
/** 文档比锚点矮这么多像素以内就算够用，避免亚像素/取整差导致无谓重试 */
const HEIGHT_TOLERANCE_PX = 2
/** 这些手势代表用户主动改变滚动位置 —— 与浏览器钳位不同，会取消待恢复的锚点 */
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '])

export function captureScrollAnchor(): ScrollAnchor | null {
  if (typeof window === 'undefined') return null
  return { left: window.scrollX, top: window.scrollY }
}

/**
 * 内容异步增高后回到锚点；文档还不够高就等待下一次尺寸变更。
 *
 * 每次调用返回自己的取消句柄 —— 待恢复的帧不能是全局单槽：路由切换与场景库筛选
 * 会同时存在待恢复锚点，共享一个槽会让一方的取消清掉另一方（实测：筛选时写 URL
 * 触发导航，路由的取消把筛选的恢复一起干掉了）。
 */
export function restoreScrollAnchor(anchor: ScrollAnchor, options: RestoreAnchorOptions = {}): () => void {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') return () => undefined
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let frame = 0
  let resize: ResizeObserver | undefined
  let timer: number | undefined
  let finished = false
  function cancel() {
    finished = true
    resize?.disconnect()
    window.clearTimeout(timer)
    window.cancelAnimationFrame(frame)
    frame = 0
  }
  function restore(expired: boolean) {
    frame = 0
    if (finished) return
    if (options.shouldContinue && !options.shouldContinue()) { cancel(); return }
    const maxTop = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
    const reachable = maxTop + HEIGHT_TOLERANCE_PX >= anchor.top
    if (!reachable && !expired) {
      if (!resize) {
        resize = new ResizeObserver(() => restore(false))
        resize.observe(document.documentElement)
        resize.observe(document.body)
        timer = window.setTimeout(() => restore(true), timeoutMs)
      }
      return
    }
    cancel()
    // Restoring context must not inherit html's smooth scrolling: that turns a
    // return into a visible trip from the new page's top to the old position.
    window.scrollTo({ left: anchor.left, top: Math.min(anchor.top, maxTop), behavior: 'instant' })
    if (reachable) options.onRestored?.()
    else options.onAbandoned?.(window.scrollY)
  }
  if (options.immediate) restore(false)
  else frame = window.requestAnimationFrame(() => restore(false))
  return cancel
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT'
}

/**
 * 监听"用户主动改变滚动位置"的手势，首次命中时回调一次。
 *
 * 只认真实手势（滚轮、触摸、滚动键）而不是比较坐标：文档被钳位后，用户再滚回
 * 同一坐标时两者无法区分。排除可编辑元素，否则在搜索框里打字会被当成滚动。
 * 返回解除监听的函数。
 */
export function watchForUserScroll(onUserScroll: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined
  let done = false
  const stop = () => {
    if (done) return
    done = true
    window.removeEventListener('wheel', onWheel)
    window.removeEventListener('touchstart', onTouch)
    window.removeEventListener('keydown', onKeydown)
  }
  const fire = () => { stop(); onUserScroll() }
  const onWheel = (event: Event) => { if (!isEditableTarget(event.target)) fire() }
  const onTouch = (event: Event) => { if (!isEditableTarget(event.target)) fire() }
  const onKeydown = (event: Event) => {
    const key = (event as KeyboardEvent).key
    if (!SCROLL_KEYS.has(key) || isEditableTarget(event.target)) return
    fire()
  }
  window.addEventListener('wheel', onWheel, { passive: true })
  window.addEventListener('touchstart', onTouch, { passive: true })
  window.addEventListener('keydown', onKeydown)
  return stop
}
