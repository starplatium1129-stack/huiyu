import type { ChatEmotion } from '@/utils/emotionRuntime'
import type { CompanionReminder } from '@/utils/companionBehavior'

/** Presentation only: authored Live2D motions and character dialogue remain the source of truth. */
interface PerformanceRule { emotion: ChatEmotion; closeEmotion?: ChatEmotion; minimumAffection?: number; expiresMs: number }
const COMPANION_PERFORMANCES: Readonly<Record<string, Readonly<PerformanceRule>>> = {
  return: { emotion: 'gentle', closeEmotion: 'happy', minimumAffection: 50, expiresMs: 90_000 },
  idle: { emotion: 'gentle', expiresMs: 90_000 },
  'image-ready': { emotion: 'happy', expiresMs: 90_000 },
  'image-files-ready': { emotion: 'gentle', expiresMs: 60_000 },
  'image-files-missing': { emotion: 'serious', expiresMs: 60_000 },
  'service-back': { emotion: 'gentle', expiresMs: 60_000 },
  'service-down': { emotion: 'serious', expiresMs: 60_000 },
}

export function companionPerformance(reminder: CompanionReminder, affection: number, now = Date.now()) {
  const key = reminder.kind === 'event' ? reminder.eventKind || '' : reminder.kind
  if (!Object.hasOwn(COMPANION_PERFORMANCES, key)) return null
  const rule = COMPANION_PERFORMANCES[key]
  if (!rule || !Number.isFinite(reminder.at) || now < reminder.at || now - reminder.at > rule.expiresMs) return null
  return { emotion: rule.closeEmotion && Number.isFinite(affection) && affection >= (rule.minimumAffection ?? 0) ? rule.closeEmotion : rule.emotion }
}
