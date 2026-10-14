export interface AudioWithSource extends HTMLAudioElement {
  __sourceNode?: MediaElementAudioSourceNode | null
}

export type AudioEndReason = 'ended' | 'cancelled' | 'blocked'
  | 'load-error' | 'play-error' | 'load-timeout' | 'play-timeout'

export function removeAudioSource(audio: AudioWithSource) {
  try { audio.__sourceNode?.disconnect() } catch {}
  audio.__sourceNode = null
}

/** Automatic sentences and message replay share the same bounded lifecycle. */
export function playVoiceAudio(audio: AudioWithSource, options: {
  onStarted?: () => void
  onSlow?: (extension: number) => void
  onCleanup?: () => void
} = {}) {
  let finished = false, started = false, waitExtensions = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let resolveResult!: (reason: AudioEndReason) => void
  const result = new Promise<AudioEndReason>(resolve => { resolveResult = resolve })
  const finish = (reason: AudioEndReason) => {
    if (finished) return
    finished = true
    if (timer !== null) clearTimeout(timer)
    audio.removeEventListener('playing', onPlaying)
    audio.removeEventListener('ended', onEnded); audio.removeEventListener('error', onError)
    // Removing the source also cancels a still-downloading sentence before a retry.
    audio.pause(); audio.removeAttribute('src'); audio.load(); removeAudioSource(audio)
    options.onCleanup?.()
    resolveResult(reason)
  }
  const scheduleLoadTimeout = () => {
    timer = setTimeout(() => {
      if (finished || started) return
      // A live remote generation may need up to three 90-second loading windows.
      if (audio.readyState < 2 && audio.networkState === 2 && waitExtensions < 2) {
        waitExtensions++
        options.onSlow?.(waitExtensions)
        scheduleLoadTimeout()
      } else finish('load-timeout')
    }, 90_000)
  }
  function onPlaying() {
    if (finished || started) return
    started = true
    if (timer !== null) clearTimeout(timer)
    // A resumed playing event must not extend the deadline indefinitely.
    timer = setTimeout(() => finish('play-timeout'), 270_000)
    options.onStarted?.()
  }
  function onEnded() { finish('ended') }
  function onError() { finish(started ? 'play-error' : 'load-error') }
  audio.addEventListener('playing', onPlaying)
  audio.addEventListener('ended', onEnded); audio.addEventListener('error', onError)
  scheduleLoadTimeout()
  void audio.play().catch(error => {
    finish(error instanceof DOMException && error.name === 'NotAllowedError'
      ? 'blocked' : started ? 'play-error' : 'load-error')
  })
  return { result, cancel: () => finish('cancelled') }
}
