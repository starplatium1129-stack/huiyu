/**
 * 有界的 window 滚动锚点。
 *
 * 布局突变（返回缓存页面、筛选把列表抽短）会让文档变矮，浏览器随即把滚动位置
 * 钳掉；等内容长回来时用户已经不在原来的位置了。这里把"记位置 + 下一帧重试恢复"
 * 抽成一套原语，路由返回（F2.3）与场景库筛选（F3.2）共用，避免并存两份实现。
 *
 * 恢复用 requestAnimationFrame 重试而不是定时器：内容何时变高由渲染决定，
 * 定时器只能靠猜。超时后放弃并把实际落点回报给调用方，不把用户永久锁在某个位置。
 */

export interface ScrollAnchor {
  left: number
  top: number
}

export interface RestoreAnchorOptions {
  /** 每帧重试前询问；返回 false 立即停止（路由已离开、组件已卸载、锚点已被取代） */
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
 * 内容异步增高后回到锚点；文档还不够高就下一帧再试，直到超时或调用方取消。
 *
 * 每次调用返回自己的取消句柄 —— 待恢复的帧不能是全局单槽：路由切换与场景库筛选
 * 会同时存在待恢复锚点，共享一个槽会让一方的取消清掉另一方（实测：筛选时写 URL
 * 触发导航，路由的取消把筛选的恢复一起干掉了）。
 */
export function restoreScrollAnchor(anchor: ScrollAnchor, options: RestoreAnchorOptions = {}): () => void {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') return () => undefined
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const started = performance.now()
  let frame = window.requestAnimationFrame(retry)
  function cancel() {
    if (!frame) return
    window.cancelAnimationFrame(frame)
    frame = 0
  }
  function retry() {
    frame = 0
    if (options.shouldContinue && !options.shouldContinue()) return
    const maxTop = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
    const reachable = maxTop + HEIGHT_TOLERANCE_PX >= anchor.top
    if (!reachable && performance.now() - started < timeoutMs) {
      frame = window.requestAnimationFrame(retry)
      return
    }
    window.scrollTo(anchor.left, Math.min(anchor.top, maxTop))
    if (reachable) options.onRestored?.()
    else options.onAbandoned?.(window.scrollY)
  }
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
