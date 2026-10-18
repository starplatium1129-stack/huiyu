import { onScopeDispose } from 'vue'
import type { UseVoiceInput } from './voiceInputRecorder'

type Hold = { kind: 'pointer'; id: number; target: Element } | { kind: 'key'; code: string }
type ManualVoiceInput = Pick<UseVoiceInput, 'state' | 'autoListening' | 'start' | 'stop' | 'cancel'>

/** One manual gesture owns the recorder until its matching release or cancellation.
 * Wake listening and text delivery remain with the caller's speech policy. */
export function useManualSpeechHold(input: ManualVoiceInput, canStart: () => boolean) {
  let held: Hold | null = null, disposed = false

  function clearHold() {
    const previous = held
    held = null
    if (previous?.kind === 'pointer' && previous.target.hasPointerCapture(previous.id)) {
      try { previous.target.releasePointerCapture(previous.id) } catch { /* The browser may already have released it. */ }
    }
  }
  function cancel() { clearHold(); input.cancel() }
  function cancelHeld() { if (held) cancel() }
  function begin(next: Hold) {
    if (disposed || held || !canStart()) return false
    if (input.autoListening.value) input.cancel()
    if (['acquiring', 'capturing', 'recognizing'].includes(input.state.value)) return false
    held = next
    if (next.kind === 'pointer') {
      try { next.target.setPointerCapture(next.id) }
      catch { held = null; return false }
    }
    void input.start('manual')
    return true
  }
  function release() {
    // Normal release can dispatch lostpointercapture immediately. Clear its
    // ownership before releasing capture, so it cannot cancel the new ASR call.
    clearHold()
    if (input.state.value === 'acquiring') input.cancel()
    else input.stop()
  }
  function pointerDown(event: PointerEvent) {
    if (event.button !== 0 || !event.isPrimary || !(event.currentTarget instanceof Element)) return
    begin({ kind: 'pointer', id: event.pointerId, target: event.currentTarget })
  }
  function pointerUp(event: PointerEvent) {
    if (held?.kind === 'pointer' && held.id === event.pointerId) release()
  }
  function pointerCancel(event: PointerEvent) {
    if (held?.kind === 'pointer' && held.id === event.pointerId) cancel()
  }
  function keyDown(event: KeyboardEvent) {
    if (![' ', 'Enter'].includes(event.key) || event.repeat || event.isComposing || event.keyCode === 229
      || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return
    if (begin({ kind: 'key', code: event.code || event.key })) event.preventDefault()
  }
  function keyUp(event: KeyboardEvent) {
    if (held?.kind !== 'key' || held.code !== (event.code || event.key)) return
    event.preventDefault()
    release()
  }
  window.addEventListener('blur', cancelHeld)
  onScopeDispose(() => { disposed = true; window.removeEventListener('blur', cancelHeld); cancel() })
  return { pointerDown, pointerUp, pointerCancel, keyDown, keyUp, cancelHeld, cancel }
}
