let locks = 0
let restore: (() => void) | undefined

/** Custom overlays and native dialogs share the document's scroll owner. */
export function acquirePageScrollLock() {
  if (!locks) {
    const root = document.documentElement
    const overflow = root.style.overflow, scrollbarGutter = root.style.scrollbarGutter
    const hasScrollbar = window.innerWidth > root.clientWidth
    const gutter = getComputedStyle(root).scrollbarGutter
    // A stable gutter preserves both normal flow and fixed surfaces. Body
    // margins/padding cannot compensate both, and body overflow breaks the shell.
    if (hasScrollbar && !gutter.includes('stable')) root.style.scrollbarGutter = 'stable'
    root.style.overflow = 'hidden'
    restore = () => {
      root.style.overflow = overflow
      root.style.scrollbarGutter = scrollbarGutter
    }
  }
  locks++
  let held = true
  return () => {
    if (!held) return
    held = false
    if (--locks === 0) { restore?.(); restore = undefined }
  }
}
