// Capture nested scroll events as well as document scrolling without changing
// native scrollbar geometry, wheel handling or keyboard scrolling.
const idleDelay = 1000
const active = new Map<Element, ReturnType<typeof setTimeout>>()

function showScrollbar(event: Event) {
  const target = event.target === document ? document.scrollingElement : event.target
  if (!(target instanceof Element)) return
  const previous = active.get(target)
  if (previous !== undefined) clearTimeout(previous)
  target.setAttribute('data-scrollbar-active', '')
  active.set(target, setTimeout(() => {
    target.removeAttribute('data-scrollbar-active')
    active.delete(target)
  }, idleDelay))
}

document.addEventListener('scroll', showScrollbar, { capture: true, passive: true })

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    document.removeEventListener('scroll', showScrollbar, true)
    for (const [target, timer] of active) {
      clearTimeout(timer)
      target.removeAttribute('data-scrollbar-active')
    }
    active.clear()
  })
}
