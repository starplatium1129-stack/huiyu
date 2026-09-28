import { readonly, ref } from 'vue'
import { settingsRepository, INTERFACE_SOUND_SETTING } from '../storage/settingsRepository.ts'

export type InterfaceTone = 'tap' | 'confirm' | 'warning' | 'success'
type Note = [frequency: number, offset: number, duration: number, volume: number]

// 同一套 D 大调五声音阶：点击像木质拨弦，确认与完成带少量铃音泛音。
// 频率固定而非扫频，避免原先电子滑音的尖促感；警告用低音区下行，不作警报。
const notes: Record<InterfaceTone, Note[]> = {
  tap: [[587.33, 0, .095, .025]],
  confirm: [[587.33, 0, .15, .027], [880, .065, .19, .022]],
  warning: [[440, 0, .17, .026], [369.99, .12, .22, .023]],
  success: [[587.33, 0, .19, .025], [739.99, .075, .22, .022], [1174.66, .15, .30, .018]],
}
const soundEnabled = ref(false)
let initialized = false
let audioContext: AudioContext | null = null
let currentEnvelope: GainNode | null = null
let lastTone: InterfaceTone | null = null
let lastTime = -Infinity
let resumePending = false

function releaseAudio() {
  const ctx = audioContext
  audioContext = null
  currentEnvelope = null
  lastTone = null
  lastTime = -Infinity
  resumePending = false
  if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => {})
}

function initialize() {
  if (initialized || typeof window === 'undefined') return
  initialized = true
  soundEnabled.value = settingsRepository.get(INTERFACE_SOUND_SETTING) ?? false
  window.addEventListener('pagehide', releaseAudio)
}

function scheduleTone(ctx: AudioContext, tone: InterfaceTone) {
  const now = ctx.currentTime
  // 连续点击不叠响；同一操作紧随的提示音优先于普通点击声。
  if (now - lastTime < .08 && (tone === 'tap' || tone === lastTone)) return
  lastTone = tone
  lastTime = now
  if (currentEnvelope) {
    currentEnvelope.gain.cancelScheduledValues(now)
    currentEnvelope.gain.setTargetAtTime(0, now, .012)
  }
  const envelope = ctx.createGain()
  envelope.connect(ctx.destination)
  currentEnvelope = envelope
  const score = notes[tone]
  let remaining = score.length * 2
  for (const [frequency, offset, duration, volume] of score) {
    // 纯净基音叠一层很轻的二次泛音；不使用噪声、失真或持续混响。
    for (const harmonic of [1, 2]) {
      const oscillator = ctx.createOscillator()
      const gain = ctx.createGain()
      const start = now + offset
      const length = harmonic === 1 ? duration : duration * .55
      oscillator.type = 'sine'
      oscillator.frequency.setValueAtTime(frequency * harmonic, start)
      gain.gain.setValueAtTime(0, start)
      gain.gain.linearRampToValueAtTime(volume * (harmonic === 1 ? 1 : .16), start + .006)
      gain.gain.exponentialRampToValueAtTime(.0001, start + length)
      gain.gain.linearRampToValueAtTime(0, start + length + .012)
      oscillator.connect(gain).connect(envelope)
      oscillator.onended = () => {
        oscillator.disconnect()
        gain.disconnect()
        if (--remaining === 0) {
          envelope.disconnect()
          if (currentEnvelope === envelope) currentEnvelope = null
        }
      }
      oscillator.start(start)
      oscillator.stop(start + length + .015)
    }
  }
}

export function playInterfaceTone(tone: InterfaceTone = 'tap', force = false): void {
  initialize()
  if (typeof window === 'undefined' || (!soundEnabled.value && !force)) return
  const AudioCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioCtor) return
  const ctx = audioContext ||= new AudioCtor()
  if (ctx.state === 'running') {
    scheduleTone(ctx, tone)
  } else if (ctx.state === 'suspended' && !resumePending) {
    resumePending = true
    void ctx.resume().then(() => {
      // 关闭音效或离开页面后，旧的恢复请求不能重新发声。
      if (audioContext === ctx && (soundEnabled.value || force)) scheduleTone(ctx, tone)
    }).catch(() => {}).finally(() => {
      if (audioContext === ctx) resumePending = false
    })
  }
}

export function useInterfaceFeedback() {
  initialize()
  function setSoundEnabled(value: boolean) {
    soundEnabled.value = value
    settingsRepository.set(INTERFACE_SOUND_SETTING, value)
    if (value) playInterfaceTone('success', true)
    else releaseAudio()
  }
  function toggleSound() { setSoundEnabled(!soundEnabled.value) }
  return { soundEnabled: readonly(soundEnabled), setSoundEnabled, toggleSound, playInterfaceTone }
}

if (import.meta.hot) import.meta.hot.dispose(() => {
  releaseAudio()
  window.removeEventListener('pagehide', releaseAudio)
})
