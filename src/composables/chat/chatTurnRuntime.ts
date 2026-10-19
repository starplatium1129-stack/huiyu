import { inferEmotion } from '@/utils/stream'
import { createMoodTagStream } from '@/utils/moodTag'
import { hasChatUserProfile, type ChatUserProfile } from '@/utils/chatUserProfile'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'
import type { ChatMessage } from './chatStorageTypes'

/** Protocol mood tags own the whole turn once present; text hints are a fallback. */
export function createTurnEmotionTracker(characterId: string, append: (text: string) => void, onEmotion?: (emotion: string) => void) {
  const emotionState = { value: 'neutral', moodTagged: false }
  let moodStream = createMoodTagStream()
  const hintPriority = ['shy', 'happy', 'sad', 'serious', 'gentle', 'neutral']
  let hintRank = hintPriority.length - 1
  let fallbackEmotion = 'neutral'
  function maybeStreamEmotion(replyText: string, committedLength: number) {
    if (!onEmotion || replyText.length < 4) return
    const tail = replyText.slice(Math.max(0, committedLength - 3))
    const hint = inferEmotion(tail)
    hintRank = Math.min(hintRank, hintPriority.indexOf(hint))
    if (hintRank === hintPriority.length - 1 && fallbackEmotion === 'neutral') fallbackEmotion = inferEmotion(tail, characterId)
    const emotion = hintRank < hintPriority.length - 1 ? hintPriority[hintRank]! : fallbackEmotion
    if (emotion !== emotionState.value) {
      emotionState.value = emotion
      onEmotion(emotion)
    }
  }
  return {
    applyTokenDelta(assistant: { content: string }, delta: string) {
      const prevCleanLen = assistant.content.length, committedLength = moodStream.committedLength
      const extracted = moodStream.push(delta)
      assistant.content = extracted.cleanText
      if (extracted.emotion) {
        emotionState.moodTagged = true
        if (extracted.emotion !== emotionState.value) {
          emotionState.value = extracted.emotion
          onEmotion?.(extracted.emotion)
        }
      } else if (!emotionState.moodTagged) maybeStreamEmotion(assistant.content, committedLength)
      append(extracted.cleanText.slice(prevCleanLen))
    },
    reset() {
      if (emotionState.value !== 'neutral') onEmotion?.('neutral')
      emotionState.value = 'neutral'
      emotionState.moodTagged = false
      moodStream = createMoodTagStream()
      hintRank = hintPriority.length - 1
      fallbackEmotion = 'neutral'
    },
  }
}

interface TurnConnection {
  provider: 'local' | 'api'
  currentModel: string
  baseUrl: string
  apiModel: string
  apiKey: string
  hostConfig: boolean
  webSearch: boolean
  reasoning: 'off' | 'low' | 'medium' | 'high'
}

function isVisionMessage(message: Record<string, unknown>): boolean {
  return Array.isArray(message.content)
    && (message.content as Array<{ type?: string }>).some(part => part.type === 'image_url')
}

export function buildChatRequestBody(args: {
  characterId: string; sessionId: string; imageUrls: string[]; hostMode: boolean; useVision: boolean
  toolsEnabled: boolean; toolResultOrigin?: string; restricted: boolean; roundMessages: Array<Record<string, unknown>>
  messages: ChatMessage[]; connection: TurnConnection; userProfile: ChatUserProfile; memories: string[]
}): string {
  const { characterId, sessionId, imageUrls, hostMode, useVision, toolsEnabled, restricted,
    roundMessages, messages, connection, userProfile, memories } = args
  const historyList = messages.slice(0, useVision && imageUrls.length ? -2 : -1)
    // Persist full replies and alternatives; only the gateway context is bounded.
    .map(message => ({ role: message.role, content: message.content.slice(0, 1200) }))
  return JSON.stringify({
    character: characterId, sessionId, provider: connection.provider,
    model: hostMode ? '' : connection.currentModel,
    api: !hostMode && connection.provider === 'api'
      ? { baseUrl: connection.baseUrl, model: connection.apiModel, apiKey: connection.apiKey } : undefined,
    hostConfig: hostMode || undefined,
    webSearch: !restricted && connection.provider === 'api' && connection.webSearch && isLocalStudioHost(),
    companionTools: toolsEnabled || undefined,
    toolResultOrigin: args.toolResultOrigin,
    reasoning: connection.reasoning,
    userProfile: hasChatUserProfile(userProfile) ? userProfile : undefined,
    memories,
    messages: [...historyList, ...(useVision ? roundMessages : roundMessages.filter(message => !isVisionMessage(message)))],
  })
}
