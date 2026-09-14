/**
 * 动效偏好读取（2026-08-22 动效审计 #5）：JS 侧的程序化滚动必须自行读取
 * prefers-reduced-motion——design-system.css 的 reduce 短路段管不到
 * behavior:'smooth' 这类 JS 调用，reduce 用户会被持续平滑滚动。
 */
const query = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-reduced-motion: reduce)')
  : null

export function prefersReducedMotion(): boolean {
  if (typeof document !== 'undefined') {
    const mode = document.documentElement.dataset.motion
    if (mode === 'reduce' || mode === 'reduced') return true
    if (mode === 'full') return false
  }
  return query?.matches === true
}

/** 程序化滚动统一取值：reduce 用户直接跳转目标位置，不做平滑补间。 */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? 'auto' : 'smooth'
}
