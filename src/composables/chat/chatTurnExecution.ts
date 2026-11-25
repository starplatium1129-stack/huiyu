import type { ComputedRef, Ref } from 'vue'
import type { useChatStorage } from './useChatStorage'
import type { useVoice } from '../useVoice'
import type { ChatUserProfile } from '@/utils/chatUserProfile'
import type { ChatConnectionOptions, createChatTurnConnection } from './chatTurnConnection'
import { runtimeFetch } from '../../platform/runtimeUrl.ts'
import type { CompanionToolResult as ToolCallResult } from './executeCompanionTool'
import type { CharacterConfig } from '../../config/characters.ts'
import {
  isAbortError,
  parseNdjsonResponse,
  streamErrorCode,
  streamErrorMessage,
} from '../../utils/stream.ts'
import type { ChatMessage } from './chatStorageTypes'
import { MAX_CHAT_DRAWINGS, parseCompanionChatImages, type CompanionChatSendOptions } from '@/types/companionDrawing'
import type { CompanionToolContext } from './companionChatTools'
import type { startTurnWatchdog } from './chatTurnWatchdog'
import { buildChatFallbackCandidates, shouldFallbackOnError, type ChatFallbackCandidate } from './chatTurnFallback'
import { abortableTask } from '@/utils/abortableTask'

export type ChatStorage = ReturnType<typeof useChatStorage>
export type VoiceController = ReturnType<typeof useVoice>
export type TurnMessages = ReturnType<ChatStorage['messages']>
export type ChatConnectionSnapshot = ReturnType<ReturnType<typeof createChatTurnConnection>['captureConnection']>
export type TurnWatchdog = ReturnType<typeof startTurnWatchdog>
export type TurnEmotionTracker = ReturnType<typeof import('./chatTurnRuntime')['createTurnEmotionTracker']>

export interface ChatConversationOptions extends ChatConnectionOptions {
  storage: ChatStorage
  voice: VoiceController
  activeChar: Ref<string>
  currentCharacter: ComputedRef<CharacterConfig>
  busy: Ref<boolean>
  chatReady: ComputedRef<boolean>
  userProfile: Ref<ChatUserProfile>
  recallMemories: (character: string, query: string) => string[]
  setBusy: (value: boolean) => void
  /** 流式回复文本驱动情绪（无配音时替代 TTS 情绪通道）；情绪变化才回调 */
  onStreamEmotion?: (emotion: string) => void
  /** 工具执行活动指示（null 表示本轮工具全部结束） */
  onToolActivity?: (activity: string | null) => void
  /** 思考过程进行中（收到 reasoning 增量）；第一个正文 token 到达时以 null 结束 */
  onThinking?: (thinking: string | null) => void
  onChatGptStatusChanged?: () => void
  nearBottom: () => boolean
  scrollBottom: () => void
}

export interface ChatTurn {
  characterId: string
  branch: string
  sessionId: string
  character: CharacterConfig
  user: ChatMessage
  assistant: ChatMessage
  messages: TurnMessages
  restricted: boolean
  regeneration?: { replyId: string; previousMid: string }
  text: string
}

export interface PendingToolCall {
  id: string
  name: string
  arguments: string
  thoughtSignature?: string
}

export interface TurnSpeechState {
  separateSpeech: boolean
  spokenThrough: number
}

export interface TurnFallbackState {
  activeConnection: ChatConnectionSnapshot
  activeFallbackLabel: string
  fallbackCandidates: ChatFallbackCandidate[] | null
  fallbackIndex: number
  triedModels: number
  notifiedChatGptFailure: boolean
}

export interface VoiceTurnMeta {
  mid: string
  voice: string
  character: string
  deferPreparation: boolean
}

export const MAX_TOOL_ROUNDS = 4

export async function streamChatAttempt(params: {
  turn: ChatTurn
  imageUrls: string[]
  hostMode: boolean
  useVision: boolean
  toolsEnabled: boolean
  museDrawing: boolean
  japaneseVoice: boolean
  toolResultOrigin?: string
  roundMessages: Array<Record<string, unknown>>
  activeConnection: ChatConnectionSnapshot
  activeFallbackLabel: string
  memories: string[]
  options: ChatConversationOptions
  attemptSignal: AbortSignal
  watchdog: TurnWatchdog
  tracker: TurnEmotionTracker
  speechState: TurnSpeechState
  toolCalls: PendingToolCall[]
  roundTextStart: number
  buildChatRequestBody: typeof import('./chatTurnRuntime')['buildChatRequestBody']
  applyModelWriteback: ReturnType<typeof createChatTurnConnection>['applyModelWriteback']
  checkCurrent: () => void
  canPresent: () => boolean
}) {
  const {
    turn, imageUrls, hostMode, useVision, toolsEnabled, museDrawing, japaneseVoice,
    toolResultOrigin, roundMessages, activeConnection, activeFallbackLabel, memories,
    options, attemptSignal, watchdog, tracker, speechState, toolCalls, roundTextStart,
    buildChatRequestBody, applyModelWriteback, checkCurrent, canPresent,
  } = params
  // DeepSeek V4：思考轮带 tool_calls 时必须回传 reasoning_content
  let roundReasoning = ''
  let drawing: Record<string, unknown> | undefined
  let speechFirst = false
  let textHasSpeech = false
  let streamedSpeech = false
  let legacySpeech = ''

  const response = await runtimeFetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: buildChatRequestBody({
      characterId: turn.characterId,
      sessionId: turn.sessionId,
      imageUrls,
      hostMode,
      useVision,
      toolsEnabled,
      museDrawing,
      japaneseVoice,
      toolResultOrigin,
      roundMessages,
      messages: turn.messages,
      connection: activeConnection,
      restricted: turn.restricted,
      userProfile: options.userProfile.value,
      memories,
    }),
    signal: attemptSignal,
  })

  await parseNdjsonResponse(response, event => {
    checkCurrent()
    watchdog.touch()
    if (event.type === 'meta' && event.model && !activeFallbackLabel) {
      applyModelWriteback(event.model, hostMode, useVision, activeConnection)
    }
    if (event.type === 'tool-call') {
      if (event.id && event.name) {
        if (!toolCalls.length && streamedSpeech) options.voice.stop({ preserveMessageAudio: true })
        toolCalls.push({ id: event.id, name: event.name, arguments: String(event.arguments || '{}'), thoughtSignature: event.thoughtSignature })
      }
      return
    }
    if (event.type === 'drawing' && museDrawing) {
      drawing = event.drawing
      return
    }
    if (event.type === 'reasoning') {
      roundReasoning += event.content || ''
      if (canPresent()) options.onThinking?.(event.content || '')
      return
    }
    if (event.type === 'japanese-speech-mode' && japaneseVoice) {
      speechState.separateSpeech = true
      speechFirst = event.speechFirst === true
      return
    }
    if (event.type === 'japanese-speech-chunk' && speechState.separateSpeech) {
      if (toolCalls.length) return
      const script = event.content?.trim()
      if (speechFirst) textHasSpeech = Boolean(script)
      if (!script || (!speechFirst && !turn.assistant.content.slice(roundTextStart).trim())) return
      if (speechFirst) {
        const unvoiced = turn.assistant.content.slice(speechState.spokenThrough)
        if (unvoiced.trim()) {
          options.voice.append(unvoiced)
          options.voice.finishTurn()
        }
      }
      options.voice.appendJapanese(script)
      streamedSpeech = true
      speechState.spokenThrough = turn.assistant.content.length
      return
    }
    if (event.type === 'japanese-speech' && speechState.separateSpeech) {
      legacySpeech = event.content || ''
      return
    }
    if (event.type !== 'token') return
    if (canPresent()) options.onThinking?.(null)
    tracker.applyTokenDelta(turn.assistant, event.content || '')
    if (textHasSpeech) speechState.spokenThrough = turn.assistant.content.length
    if (options.nearBottom()) options.scrollBottom()
  })

  return { roundReasoning, drawing, streamedSpeech, legacySpeech }
}

export async function resolveChatFallback(params: {
  attemptError: unknown
  userAborted: boolean
  attemptAborted: boolean
  watchdog: TurnWatchdog
  turn: ChatTurn
  usedToolsSize: number
  toolCallsLength: number
  separateSpeech: boolean
  connection: ChatConnectionSnapshot
  fallbackState: TurnFallbackState
  options: ChatConversationOptions
  checkCurrent: () => void
}): Promise<ChatFallbackCandidate | null> {
  const {
    attemptError, userAborted, attemptAborted, watchdog, turn, usedToolsSize,
    toolCallsLength, separateSpeech, connection, fallbackState, options, checkCurrent,
  } = params
  const canSwitch = !userAborted
    && !turn.assistant.content.length
    && !usedToolsSize
    && !toolCallsLength
    && !turn.assistant.drawingBatchId
    && !separateSpeech
    && shouldFallbackOnError(attemptError, attemptAborted, watchdog.idleTimedOut, watchdog.sawFirstEvent)
  if (!canSwitch) return null

  if (fallbackState.activeConnection.provider === 'chatgpt' && !fallbackState.notifiedChatGptFailure) {
    const code = streamErrorCode(attemptError)
    if (['CHATGPT_USAGE_LIMIT', 'CHATGPT_REAUTH_REQUIRED', 'CHATGPT_PLAN_NOT_ENABLED', 'CHATGPT_SCOPE_DENIED', 'CHATGPT_SELECTION_CHANGED'].includes(code)) {
      fallbackState.notifiedChatGptFailure = true
      options.onChatGptStatusChanged?.()
    }
  }
  if (fallbackState.fallbackCandidates === null) {
    fallbackState.fallbackCandidates = await buildChatFallbackCandidates(connection, {
      configured: Boolean(options.hostApiConfigured?.value),
      baseUrl: options.hostApiBaseUrl?.value || '',
      model: options.hostApiModel?.value || '',
    })
    checkCurrent()
  }
  const nextCandidate = fallbackState.fallbackCandidates[fallbackState.fallbackIndex++]
  if (!nextCandidate) return null

  fallbackState.triedModels += 1
  fallbackState.activeFallbackLabel = nextCandidate.label
  fallbackState.activeConnection = {
    ...connection,
    provider: 'api',
    hostConfig: nextCandidate.kind === 'host',
    baseUrl: nextCandidate.baseUrl,
    hostBaseUrl: nextCandidate.kind === 'host' ? nextCandidate.baseUrl : connection.hostBaseUrl,
    apiModel: nextCandidate.model,
    apiKey: nextCandidate.apiKey,
  }
  return nextCandidate
}

export async function submitMuseDrawing(params: {
  drawing: Record<string, unknown>
  connection: ChatConnectionSnapshot
  connectionMatches: ReturnType<typeof createChatTurnConnection>['connectionMatches']
  options: ChatConversationOptions
  toolContext: CompanionToolContext
  report: (message: string) => void
  checkCurrent: () => void
  canPresent: () => boolean
}) {
  const { drawing, connection, connectionMatches, options, toolContext, report, checkCurrent, canPresent } = params
  try {
    const { generateCompanionDrawingBatch } = await import('./companionDrawingBatch')
    checkCurrent()
    if (!connectionMatches(connection) || !options.companionTools.value) throw new Error('房间工具或连接已改变')
    report('正在提交出图…')
    const batch = await generateCompanionDrawingBatch({ ...drawing, action: 'generate' }, toolContext, { background: true })
    checkCurrent()
    if (batch.output && canPresent()) options.onError(batch.output, 'info')
  } catch (error) {
    checkCurrent()
    if (canPresent()) options.onError(`出图提交未确认：${error instanceof Error ? error.message : '请稍后重试。'}`)
  }
}

export async function executeChatToolRound(params: {
  toolCalls: PendingToolCall[]
  roundReasoning: string
  searchEnabled: boolean
  toolsEnabled: boolean
  roundMessages: Array<Record<string, unknown>>
  controller: AbortController
  turn: ChatTurn
  options: ChatConversationOptions
  toolContext: CompanionToolContext
  usedTools: Set<string>
  drawingResults: Map<string, ToolCallResult>
  streamedSpeech: boolean
  speechState: TurnSpeechState
  voiceTurn: VoiceTurnMeta
  report: (message: string) => void
  checkCurrent: () => void
  canPresent: () => boolean
}): Promise<boolean> {
  const {
    toolCalls, roundReasoning, searchEnabled, toolsEnabled, roundMessages,
    controller, turn, options, toolContext, usedTools, drawingResults,
    streamedSpeech, speechState, voiceTurn, report, checkCurrent, canPresent,
  } = params
  if (toolCalls.some(call => call.name === 'search_web' ? !searchEnabled : !toolsEnabled)) {
    throw new Error('请求的工具当前未启用，已停止执行。')
  }
  roundMessages.push({
    role: 'assistant',
    content: '',
    ...(roundReasoning ? { reasoning_content: roundReasoning.slice(0, 20000) } : {}),
    tool_calls: toolCalls.map(call => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
      ...(call.thoughtSignature ? { extra_content: { google: { thought_signature: call.thoughtSignature } } } : {}),
    })),
  })
  const { executeSerializedCompanionChatTool, retainCompanionImageMessage } = await abortableTask(
    () => import('./companionChatTools'),
    controller.signal,
  )
  let nextVisionRound = false
  for (const call of toolCalls) {
    checkCurrent()
    if (call.name !== 'search_web' && !options.companionTools.value) throw new Error('房间工具已关闭，已停止后续调用。')
    report(call.name === 'search_web' ? '正在联网检索…' : call.name.startsWith('generate_') ? '正在准备图片…' : '正在处理你的请求…')
    let result: ToolCallResult
    try {
      result = await executeSerializedCompanionChatTool(call, toolContext, drawingResults)
    } catch (error) {
      if (controller.signal.aborted) throw error
      result = { ok: false, output: error instanceof Error ? error.message : String(error) }
    }
    checkCurrent()
    if (call.name !== 'search_web') usedTools.add(call.name)
    const images = parseCompanionChatImages(result.images ?? (result.image ? [result.image] : []))
    if (images.length) {
      const existing = turn.assistant.images || []
      const added = images.filter(image => !existing.some(item => item.taskId === image.taskId && item.path === image.path))
      if (added.length) {
        turn.assistant.images = [...existing, ...added].slice(-MAX_CHAT_DRAWINGS)
        if (!turn.assistant.content.trim() && !turn.assistant.drawingBatchId) turn.assistant.content = result.output
      }
    }
    if (images.length || result.drawingBatchId) {
      await retainCompanionImageMessage(options.storage, result.image?.taskId, result.drawingBatchId)
      checkCurrent()
    }
    roundMessages.push({ role: 'tool', tool_call_id: call.id, content: call.name === 'search_web' ? result.output : result.output.slice(0, 60000) })
    // 图片结果继续使用本次选定的 API 进行视觉理解。
    if (['read_image', 'capture_screen'].includes(call.name) && result.ok && result.imageDataUrl) {
      roundMessages.push({
        role: 'user',
        content: [
          { type: 'text', text: `（这是 ${call.name} 返回的图片，请结合它回答）` },
          { type: 'image_url', image_url: { url: result.imageDataUrl } },
        ],
      })
      nextVisionRound = true
    }
  }
  if (canPresent()) options.onToolActivity?.(null)
  if (options.nearBottom()) options.scrollBottom()
  if (streamedSpeech) {
    speechState.spokenThrough = turn.assistant.content.length
    options.voice.startTurn(voiceTurn)
  }
  return nextVisionRound
}

export function handleChatTurnError(params: {
  error: unknown
  controller: AbortController
  attemptController: AbortController
  sendOptions: CompanionChatSendOptions
  turn: ChatTurn
  options: ChatConversationOptions
  watchdog: TurnWatchdog
  connection: ChatConnectionSnapshot
  fallbackState: TurnFallbackState
  canPresent: () => boolean
}) {
  const { error, controller, attemptController, sendOptions, turn, options, watchdog, connection, fallbackState, canPresent } = params
  const aborted = controller.signal.aborted || attemptController.signal.aborted || isAbortError(error)
  if (sendOptions.action === 'generate-from-image' && !aborted && !turn.assistant.content) {
    turn.assistant.content = `这次未能生成图片：${error instanceof Error ? error.message : '请检查绘图和反推服务后重试。'}`
  }
  // 中断时保留已收到的内容，避免读到一半的回复突然消失。
  turn.assistant.content = turn.assistant.content.trim()
  turn.assistant.stopped = Boolean(turn.assistant.content)
  if (!turn.assistant.content && !turn.assistant.drawingBatchId && !turn.regeneration) {
    const history = options.storage.messages(turn.characterId), index = history.indexOf(turn.assistant)
    if (index >= 0) history.splice(index, 1)
  }
  if (aborted) {
    if (watchdog.idleTimedOut) {
      // 超时中断：与用户主动停止不同，按失败处理并给出可理解的提示。
      options.voice.stop({ preserveMessageAudio: true, silent: true })
      const prefix = fallbackState.triedModels > 1 ? `已尝试 ${fallbackState.triedModels} 个可用模型，均响应超时：` : ''
      if (canPresent()) options.onError(watchdog.sawFirstEvent
        ? `${prefix}对话长时间无响应，已中断，请重试。`
        : `${prefix}对话等待超时（长时间未开始），请重试。`)
    }
    return
  }
  options.voice.stop({ preserveMessageAudio: true, silent: true })
  const code = streamErrorCode(error)
  const sticky = ['CHATGPT_USAGE_LIMIT', 'CHATGPT_REAUTH_REQUIRED', 'CHATGPT_PLAN_NOT_ENABLED', 'CHATGPT_SCOPE_DENIED'].includes(code)
  if (connection.provider === 'chatgpt' && !fallbackState.notifiedChatGptFailure && (sticky || code === 'CHATGPT_SELECTION_CHANGED')) {
    options.onChatGptStatusChanged?.()
  }
  const detail = streamErrorMessage(
    error,
    fallbackState.activeConnection.provider === 'muse' ? 'Muse 暂时无法回复，请在聊天设置中检查收信状态。'
      : fallbackState.activeConnection.provider === 'chatgpt' ? 'ChatGPT 订阅对话暂不可用，请检查账号状态与用量限额。'
        : fallbackState.activeConnection.provider === 'api'
          ? 'API 对话暂不可用，请检查地址、模型名和密钥。'
          : '聊天暂不可用，请检查 Ollama。',
  )
  const finalMessage = fallbackState.triedModels > 1 ? `已尝试 ${fallbackState.triedModels} 个可用模型，均暂不可用：${detail}` : detail
  if (canPresent()) options.onError(finalMessage, 'error', sticky && fallbackState.triedModels === 1 ? 0 : 7000, code)
}
