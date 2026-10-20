import { getCompanionCharacterConfig } from './companionRegistry'

/** The character window publishes this snapshot; the chat window only consumes it. */
export interface CompanionChatLiveState {
  busy: boolean
  thinking: boolean
  toolActivity: string
  speaking: boolean
  voiceActive: boolean
  activeChar: string
  chatReady: boolean
  chatError: string
  ts: number
}

export function decodeCompanionChatLiveState(
  value: unknown,
  previous: Readonly<CompanionChatLiveState>,
): CompanionChatLiveState | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  return {
    busy: Boolean(raw.busy),
    thinking: Boolean(raw.thinking),
    toolActivity: typeof raw.toolActivity === 'string' ? raw.toolActivity.slice(0, 400) : '',
    speaking: Boolean(raw.speaking),
    voiceActive: Boolean(raw.voiceActive),
    // Missing or invalid character/readiness fields retain their last usable values.
    activeChar: typeof raw.activeChar === 'string' && getCompanionCharacterConfig(raw.activeChar)
      ? raw.activeChar : previous.activeChar,
    chatReady: typeof raw.chatReady === 'boolean' ? raw.chatReady : previous.chatReady,
    chatError: typeof raw.chatError === 'string' ? raw.chatError.slice(0, 1200) : '',
    ts: Number(raw.ts) || 0,
  }
}
