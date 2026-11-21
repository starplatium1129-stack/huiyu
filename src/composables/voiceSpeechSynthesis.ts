import type { AudioEndReason } from './voiceAudioPlayback.ts'

export interface SystemSpeechRequest {
  text: string
  voice: string
  language: 'zh' | 'ja'
  volume: number
  onStarted?: () => void
  onMouth?: (value: number) => void
  onAudioLevel?: (level: number, peak: number) => void
}

export function isSystemSpeechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

export function cancelSystemSpeech(): void {
  if (!isSystemSpeechSupported()) return
  try {
    window.speechSynthesis.cancel()
  } catch { /* 桌面内核关闭阶段忽略 */ }
}

function pickSystemVoice(language: 'zh' | 'ja'): SpeechSynthesisVoice | null {
  if (!isSystemSpeechSupported()) return null
  const voices = window.speechSynthesis.getVoices()
  if (!voices.length) return null
  const prefix = language === 'ja' ? 'ja' : 'zh'
  const preferred = language === 'ja' ? 'ja-jp' : 'zh-cn'
  return voices.find(v => v.lang.toLowerCase() === preferred)
    ?? voices.find(v => v.lang.toLowerCase().startsWith(prefix))
    ?? null
}

export function playSystemSpeech(request: SystemSpeechRequest): {
  cancel: () => void
  result: Promise<AudioEndReason>
} {
  if (!isSystemSpeechSupported()) {
    return { cancel: () => {}, result: Promise.resolve('play-error') }
  }
  let settled = false
  let frame = 0
  let speaking = false
  let resolvedByCancel = false
  let finish: (reason: AudioEndReason) => void = () => {}
  const result = new Promise<AudioEndReason>((resolve) => {
    finish = resolve
  })

  const stopEnvelope = () => {
    speaking = false
    if (frame) cancelAnimationFrame(frame)
    frame = 0
    request.onMouth?.(0)
    request.onAudioLevel?.(0, 0)
  }

  const startEnvelope = () => {
    if (speaking || document.hidden) return
    speaking = true
    const t0 = performance.now()
    const tick = () => {
      if (!speaking || document.hidden) {
        frame = 0
        request.onMouth?.(0)
        request.onAudioLevel?.(0, 0)
        return
      }
      const elapsed = (performance.now() - t0) / 1000
      const level = Math.min(
        0.85,
        Math.max(0.08, 0.34 + 0.28 * Math.sin(elapsed * 13.5) + 0.16 * Math.cos(elapsed * 21.0)),
      )
      request.onMouth?.(level)
      request.onAudioLevel?.(level, Math.min(1, level * 1.15))
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
  }

  const utterance = new SpeechSynthesisUtterance(request.text)
  utterance.lang = request.language === 'ja' ? 'ja-JP' : 'zh-CN'
  utterance.volume = Math.max(0, Math.min(1, request.volume))
  utterance.pitch = request.voice === 'nene' ? 1.08 : 0.96
  utterance.rate = request.voice === 'nene' ? 1.02 : 0.97
  const matchedVoice = pickSystemVoice(request.language)
  if (matchedVoice) utterance.voice = matchedVoice

  const settle = (reason: AudioEndReason) => {
    if (settled) return
    settled = true
    stopEnvelope()
    utterance.onstart = null
    utterance.onend = null
    utterance.onerror = null
    finish(reason)
  }

  utterance.onstart = () => {
    if (settled) return
    request.onStarted?.()
    startEnvelope()
  }
  utterance.onend = () => settle(resolvedByCancel ? 'cancelled' : 'ended')
  utterance.onerror = () => settle(resolvedByCancel ? 'cancelled' : 'play-error')

  try {
    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(utterance)
  } catch {
    settle('play-error')
  }

  return {
    cancel: () => {
      if (settled) return
      resolvedByCancel = true
      cancelSystemSpeech()
      settle('cancelled')
    },
    result,
  }
}
