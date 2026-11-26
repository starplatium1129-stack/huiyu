import { inferEmotion } from '@/utils/stream'
import { createMoodTagStream } from '@/utils/moodTag'
import { hasChatUserProfile, type ChatUserProfile } from '@/utils/chatUserProfile'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'
import { resolveActiveRpPreset, resolveEffectiveSampling, type ChatRpState } from '@/utils/chatRpSettings'
import type { ChatMessage, ChatProvider } from './chatStorageTypes'

/** Protocol mood tags own the whole turn once present; text hints are a fallback. */
export function createTurnEmotionTracker(
  characterId: string,
  append: (text: string) => void,
  onEmotion?: (emotion: string, explicit?: boolean) => void,
  initialText = '',
) {
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
      onEmotion(emotion, false)
    }
  }
  return {
    applyTokenDelta(assistant: { content: string }, delta: string) {
      const prevTailLen = Math.max(0, assistant.content.length - initialText.length)
      const committedLength = moodStream.committedLength
      const extracted = moodStream.push(delta)
      assistant.content = initialText + extracted.cleanText
      if (extracted.emotion) {
        const wasTagged = emotionState.moodTagged
        emotionState.moodTagged = true
        if (!wasTagged || extracted.emotion !== emotionState.value) {
          emotionState.value = extracted.emotion
          onEmotion?.(extracted.emotion, true)
        }
      } else if (!emotionState.moodTagged) maybeStreamEmotion(extracted.cleanText, committedLength)
      append(extracted.cleanText.slice(prevTailLen))
    },
    reset() {
      if (emotionState.value !== 'neutral') onEmotion?.('neutral', false)
      emotionState.value = 'neutral'
      emotionState.moodTagged = false
      moodStream = createMoodTagStream()
      hintRank = hintPriority.length - 1
      fallbackEmotion = 'neutral'
    },
  }
}

interface TurnConnection {
  provider: ChatProvider
  currentModel: string
  chatgptModel: string
  chatgptClientId: string
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
  toolsEnabled: boolean; museDrawing: boolean; toolResultOrigin?: string; restricted: boolean; roundMessages: Array<Record<string, unknown>>
  japaneseVoice: boolean; continueMode?: boolean; rpState?: ChatRpState
  affection?: { score: number; level: number; title: string; description: string }
  sceneState?: { location: string; outfit: string; mood: string }
  extraPayload?: Record<string, unknown>
  messages: ChatMessage[]; connection: TurnConnection; userProfile: ChatUserProfile; memories: string[]
}): string {
  const { characterId, sessionId, imageUrls, hostMode, useVision, toolsEnabled, restricted,
    roundMessages, messages, connection, userProfile, memories, continueMode, rpState, affection, sceneState, extraPayload } = args
  const maxMessages = rpState?.contextBudget.maxMessages ?? 48
  const maxChars = rpState?.contextBudget.maxChars ?? 32_000
  const rawHistory = continueMode
    ? messages
    : messages.slice(0, useVision && imageUrls.length ? -2 : -1)
  const boundedHistory: Array<{ role: 'user' | 'assistant'; content: string }> = []
  let usedChars = 0
  for (let index = rawHistory.length - 1; index >= 0 && boundedHistory.length < maxMessages; index -= 1) {
    const message = rawHistory[index]
    if (!message.content && message.drawingBatchId) continue
    const content = message.content.slice(-16_000).replace(/^[\uDC00-\uDFFF]/u, '')
    if (!content.trim()) continue
    if (usedChars + content.length > maxChars && boundedHistory.length > 0) break
    usedChars += content.length
    boundedHistory.push({ role: message.role, content })
  }
  boundedHistory.reverse()

  const activePreset = rpState ? resolveActiveRpPreset(rpState) : undefined
  const sampling = rpState ? resolveEffectiveSampling(rpState) : undefined
  const authorNote = rpState?.authorNotes[characterId]
  const activeNote = authorNote?.enabled && authorNote.text.trim()
    ? { text: authorNote.text.trim(), depth: authorNote.depth }
    : undefined
  const statusBarEnabled = Boolean(rpState?.statusBarEnabled)
  const hasRpPreset = Boolean(activePreset && (activePreset.systemPrefix || activePreset.postHistory || activePreset.disableBubbleSplit || statusBarEnabled))
  const hasSceneState = Boolean(sceneState && (sceneState.location || sceneState.outfit || sceneState.mood))

  const resolvedProfile = extraPayload?.userProfile && typeof extraPayload.userProfile === 'object'
    ? extraPayload.userProfile as ChatUserProfile
    : userProfile

  return JSON.stringify({
    character: characterId, sessionId, provider: connection.provider,
    chatgptClientId: connection.provider === 'chatgpt' ? connection.chatgptClientId || undefined : undefined,
    model: connection.provider === 'muse' ? undefined : connection.provider === 'chatgpt' ? connection.chatgptModel : hostMode ? '' : connection.currentModel,
    api: !hostMode && connection.provider === 'api'
      ? { baseUrl: connection.baseUrl, model: connection.apiModel, apiKey: connection.apiKey } : undefined,
    hostConfig: hostMode || undefined,
    webSearch: !restricted && (connection.provider === 'api' || connection.provider === 'chatgpt') && connection.webSearch && isLocalStudioHost(),
    companionTools: toolsEnabled || undefined,
    museDrawing: args.museDrawing || undefined,
    japaneseVoice: args.japaneseVoice || undefined,
    toolResultOrigin: args.toolResultOrigin,
    reasoning: connection.reasoning,
    contextBudget: rpState ? { maxMessages, maxChars } : undefined,
    sampling: sampling && Object.keys(sampling).length ? sampling : undefined,
    rpPreset: hasRpPreset
      ? {
          systemPrefix: activePreset?.systemPrefix || '',
          postHistory: activePreset?.postHistory || '',
          disableBubbleSplit: Boolean(activePreset?.disableBubbleSplit),
          statusBarEnabled,
        }
      : undefined,
    authorNote: activeNote,
    affection: rpState?.affectionPromptEnabled !== false ? affection : undefined,
    sceneState: hasSceneState ? sceneState : undefined,
    lorebooks: extraPayload?.lorebooks,
    storySummary: typeof extraPayload?.storySummary === 'string' && extraPayload.storySummary ? extraPayload.storySummary : undefined,
    continueMode: continueMode || undefined,
    userProfile: hasChatUserProfile(resolvedProfile) ? resolvedProfile : undefined,
    memories,
    messages: [...boundedHistory, ...(useVision ? roundMessages : roundMessages.filter(message => !isVisionMessage(message)))],
  })
}
