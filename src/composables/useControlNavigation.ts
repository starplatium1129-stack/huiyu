import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

export function useControlNavigation(ids: string[]) {
  const route = useRoute()
  const activeSection = ref(ids[0] || '')
  let frame = 0
  let requested = ''
  let arrived = false
  function update() {
    frame = 0
    const target = document.getElementById(requested)
    if (target) {
      const bounds = target.getBoundingClientRect()
      if (bounds.top < innerHeight && bounds.bottom > 140) { arrived = true; activeSection.value = requested; return }
      if (!arrived) { activeSection.value = requested; return }
      requested = ''
    }
    let current = ids[0] || ''
    let closestTop = -Infinity
    for (const id of ids) {
      const section = document.getElementById(id)
      const top = section?.getBoundingClientRect().top
      if (top !== undefined && top <= 140 && top > closestTop) { current = id; closestTop = top }
    }
    activeSection.value = current
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(update) }
  function openSection(id: string, event?: MouseEvent) {
    if (event && (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)) return
    const section = document.getElementById(id)
    if (section instanceof HTMLDetailsElement) section.open = true
    requested = id
    arrived = false
    activeSection.value = id
    const origin = event?.currentTarget
    if (event?.detail === 0 && origin instanceof HTMLElement && document.activeElement === origin) {
      void nextTick(() => {
        if (!origin.isConnected || document.activeElement !== origin || !section?.isConnected) return
        const target = section.querySelector<HTMLElement>(section instanceof HTMLDetailsElement ? ':scope > summary' : 'h2,h3') || section
        if (!target.matches('a[href],button,input,select,textarea,summary,[tabindex]')) target.tabIndex = -1
        target.focus({ preventScroll: true })
      })
    }
  }
  onMounted(() => {
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule, { passive: true })
    const initial = route.hash.slice(1)
    if (ids.includes(initial)) openSection(initial)
    schedule()
  })
  watch(() => route.hash, hash => { if (ids.includes(hash.slice(1))) openSection(hash.slice(1)) }, { flush: 'post' })
  onUnmounted(() => {
    window.removeEventListener('scroll', schedule)
    window.removeEventListener('resize', schedule)
    cancelAnimationFrame(frame)
  })
  return { activeSection, openSection }
}
