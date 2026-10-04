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

/** Bind system/app preferences and visibility until the consumer releases them. */
export function listenMotionChanges(preference: () => void, visibility = preference): () => void {
  const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
  const modern = typeof media?.addEventListener === 'function'
  if (modern) media?.addEventListener('change', preference)
  else media?.addListener?.(preference)
  window.addEventListener('atelier:motion-preference', preference)
  document.addEventListener('visibilitychange', visibility)
  return () => {
    if (modern) media?.removeEventListener('change', preference)
    else media?.removeListener?.(preference)
    window.removeEventListener('atelier:motion-preference', preference)
    document.removeEventListener('visibilitychange', visibility)
  }
}

/** 程序化滚动统一取值：reduce 用户直接跳转目标位置，不做平滑补间。 */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? 'auto' : 'smooth'
}
