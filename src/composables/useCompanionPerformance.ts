import { onUnmounted, watch, type Ref } from 'vue'
import { companionPerformance } from '@/config/companionPerformances'
import type { CompanionReminder } from '@/utils/companionBehavior'
import type { useVoice } from './useVoice'

interface PerformanceDeps {
  activeChar: Ref<string>
  reminders: Ref<CompanionReminder[]>
  stage: Ref<{ setEmotion: (value: string) => void } | undefined>
  allowed: () => boolean
  autoVoice: Ref<boolean>
  voiceActive: Ref<boolean>
  voiceId: () => string
  affection: () => number
  voice: Pick<ReturnType<typeof useVoice>, 'isActive' | 'ownsTurn' | 'readyFor' | 'startTurn' | 'append' | 'finishTurn' | 'stop' | 'clearMessages'>
}

/** Shares the room's audio/Live2D lifecycle. Passive cues never write chat history or run tools. */
export function useCompanionPerformance(deps: PerformanceDeps) {
  const seen = new Set<string>()
  let owner: { id: string; character: string; audio: boolean } | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  function release(stop = false) {
    const previous = owner
    owner = null
    clearTimeout(timer)
    if (!previous) return
    const ownsAudio = previous.audio && deps.voice.ownsTurn(previous.id)
    if (stop && ownsAudio) deps.voice.stop({ preserveMessageAudio: true, silent: true })
    if (previous.audio) deps.voice.clearMessages([previous.id])
    if (previous.character === deps.activeChar.value && (ownsAudio || !deps.voice.isActive())) deps.stage.value?.setEmotion('neutral')
  }

  function reconcile() {
    if (disposed) return
    if (!deps.allowed() || owner && (owner.character !== deps.activeChar.value || owner.audio && !deps.autoVoice.value)) {
      release(true)
      return
    }
    if (owner) {
      if (owner.audio && !deps.voice.ownsTurn(owner.id) || !owner.audio && deps.voice.isActive()) release()
      else if (owner.audio && !deps.voiceActive.value && !deps.voice.isActive()) release()
      else return
    }
    if (!deps.stage.value || deps.voice.isActive()) return
    // At most one fresh cue per observed change. Old queued bubbles stay readable but are not replayed.
    for (const reminder of deps.reminders.value) {
      const key = `${deps.activeChar.value}:${reminder.id}`
      if (seen.has(key)) continue
      seen.add(key)
      if (seen.size > 100) seen.delete(seen.values().next().value!)
      const cue = companionPerformance(reminder, deps.affection())
      if (!cue) continue
      const id = `companion-cue-${reminder.id}`
      const audio = deps.autoVoice.value && deps.voice.readyFor(deps.voiceId())
      owner = { id, character: deps.activeChar.value, audio }
      try {
        if (audio) {
          deps.voice.startTurn({ mid: id, character: deps.activeChar.value, voice: deps.voiceId(), emotion: cue.emotion })
          deps.voice.append(reminder.line)
          deps.voice.finishTurn()
        }
        deps.stage.value.setEmotion(cue.emotion)
        timer = setTimeout(() => release(true), audio ? 45_000 : 8000)
      } catch { release(true) }
      return
    }
  }
  watch(() => [deps.allowed(), deps.activeChar.value, deps.autoVoice.value], () => {
    if (owner && (!deps.allowed() || owner.character !== deps.activeChar.value || owner.audio && !deps.autoVoice.value)) release(true)
  }, { flush: 'sync' })
  watch(() => [deps.reminders.value, deps.stage.value, deps.activeChar.value, deps.allowed(), deps.autoVoice.value, deps.voiceActive.value], reconcile, { immediate: true, flush: 'post' })
  onUnmounted(() => { disposed = true; release(true) })
}
