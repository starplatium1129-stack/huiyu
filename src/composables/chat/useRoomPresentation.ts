import { onMounted, onUnmounted, ref } from 'vue'
import { ROOM_PRESENTATION_KEY as key } from '@/utils/storageKeys'

/** Focused full room owns the animated presentation; the pet resumes when it leaves. */
export function useRoomPresentation(surface: 'room' | 'companion') {
  const suspended = ref(false)
  const id = Math.random().toString(36).slice(2)
  let timer = 0
  function update() {
    if (!window.companionDesktop) return
    try {
      const record = JSON.parse(localStorage.getItem(key) || 'null')
      if (surface === 'room') {
        const active = !document.hidden && document.hasFocus()
        suspended.value = !active
        if (active) localStorage.setItem(key, JSON.stringify({ id, ts: Date.now() }))
        else if (record?.id === id) localStorage.removeItem(key)
      } else suspended.value = Boolean(record && Date.now() - record.ts < 12000)
    } catch { suspended.value = false }
  }
  onMounted(() => {
    update()
    timer = window.setInterval(update, 4000)
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    window.addEventListener('storage', update)
    document.addEventListener('visibilitychange', update)
  })
  onUnmounted(() => {
    clearInterval(timer)
    window.removeEventListener('focus', update)
    window.removeEventListener('blur', update)
    window.removeEventListener('storage', update)
    document.removeEventListener('visibilitychange', update)
    try { if (JSON.parse(localStorage.getItem(key) || 'null')?.id === id) localStorage.removeItem(key) } catch { /* unavailable */ }
  })
  return suspended
}
