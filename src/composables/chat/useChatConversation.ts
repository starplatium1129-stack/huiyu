import { createChatTurnConnection } from './chatTurnConnection'
import type { CompanionToolResult as ToolCallResult } from './executeCompanionTool'
import { reactive, ref } from 'vue'
import { createMessageId } from '../../config/characters.ts'
import { isAbortError } from '../../utils/stream.ts'
import { isLocalStudioHost } from '../../utils/runtimeEnvironment.ts'
import { registerMaintenanceParticipant } from '@/platform/maintenanceParticipants'
import { createChatDraftPersistence } from './chatDraftPersistence'
import type { ChatMessage } from './chatStorageTypes'
import type { CompanionChatSendOptions } from '@/types/companionDrawing'
import type { CompanionToolContext } from './companionChatTools'
import { captureCompanionImageSource } from './companionChatImages'
import { startTurnWatchdog } from './chatTurnWatchdog'
import { abortableTask } from '@/utils/abortableTask'
import { loadCompanionToolPermissions, companionToolAllowed } from './useCompanionToolPermissions'
import { hasRuntimeTasks } from '@/api/runtimeTaskAuthority'
import {
  MAX_TOOL_ROUNDS,
  executeChatToolRound,
  handleChatTurnError,
  resolveChatFallback,
  streamChatAttempt,
  submitMuseDrawing,
  type ChatConnectionSnapshot,
  type ChatConversationOptions,
  type ChatTurn,
  type PendingToolCall,
  type TurnFallbackState,
  type TurnMessages,
  type TurnSpeechState,
} from './chatTurnExecution'

export function useChatConversation(options: ChatConversationOptions) {
  const inputText = ref('')
  const streamingMid = ref('')
  const replyAnnouncement = ref('')
  let activeRequest: AbortController | null = null
  let disposed = false
  const sessions = new Map<string, { revision: number; branch: string; mids: string[]; id: string }>()
  const draft = createChatDraftPersistence((character, value) => options.storage.setDraft(character, value))
  const releaseMaintenance = registerMaintenanceParticipant(() => { if (options.busy.value) throw new Error('CHAT_BUSY') })

  function abortCurrentRequest(silent = false, cancelImage = true) {
    if (!activeRequest) return false
    activeRequest.abort(cancelImage ? 'user-cancel' : undefined)
    options.voice.stop({ preserveMessageAudio: true, silent: true })
    if (!silent) options.onError('已停止本次回复。', 'info', 2500)
    return true
  }

  function stopEverything() {
    const wasBusy = Boolean(activeRequest)
    const wasSpeaking = options.voice.isActive()
    if (!wasBusy && !wasSpeaking) return false
    abortCurrentRequest(true)
    options.voice.stop({ preserveMessageAudio: true, silent: true })
    options.onError(wasBusy ? '已停止本次回复。' : '已停止语音播放。', 'info', 2500)
    return true
  }

  function sessionId(characterId: string, messages: TurnMessages) {
    const revision = options.storage.state.historiesRevisions[characterId] ?? 0
    const branch = options.storage.branchId(characterId), mids = messages.map(message => message.mid)
    let session = sessions.get(characterId)
    // Appending continues the same session; branch/variant changes select a new tool owner.
    if (!session || session.revision !== revision || session.branch !== branch
      || session.mids.some((mid, index) => mids[index] !== mid)) {
      session = { revision, branch, mids, id: createMessageId() }
      sessions.set(characterId, session)
    } else session.mids = mids
    return session.id
  }

  function createAssistant() {
    const mid = createMessageId()
    return reactive<ChatMessage>({ role: 'assistant', content: '', mid, replyId: mid, stopped: false })
  }

  function captureTurn(characterId: string, user: ChatMessage, assistant: ChatMessage, restricted = false,
    regeneration?: { replyId: string; previousMid: string }): ChatTurn {
    const messages = options.storage.messages(characterId)
    replyAnnouncement.value = ''
    streamingMid.value = assistant.mid
    options.scrollBottom()
    options.setBusy(true)
    return { characterId, branch: options.storage.branchId(characterId), sessionId: sessionId(characterId, messages),
      character: options.currentCharacter.value, user, assistant, messages, restricted, regeneration,
      text: restricted ? user.content.replace(/\s*\[图片\]\s*$/, '').trim() : user.content }
  }

  function beginUserTurn(text: string, imageUrl: string | undefined, customText?: string, sendOptions: CompanionChatSendOptions = {}) {
    const characterId = options.activeChar.value, messages = options.storage.messages(characterId)
    const greeting = options.currentCharacter.value.greeting
    if (!messages.length && greeting) {
      messages.push({ role: 'assistant', content: greeting, mid: createMessageId(), stopped: false })
    }
    const user: ChatMessage = { role: 'user', content: imageUrl || sendOptions.image ? `${text || '（发送了图片）'} [图片]` : text,
      mid: createMessageId(), stopped: false, ...(sendOptions.image ? { images: [{ ...sendOptions.image }] } : {}) }
    messages.push(user)
    options.storage.trim(characterId)
    const assistant = createAssistant()
    messages.push(assistant)
    options.storage.save(true, true, [characterId])
    if (customText === undefined) {
      draft.clear()
      inputText.value = ''
      options.storage.setDraft(characterId, '')
    }
    const turn = captureTurn(characterId, user, assistant)
    turn.text = text
    return turn
  }

  const { captureConnection, connectionMatches, applyModelWriteback } = createChatTurnConnection(options)

  async function sendMessage(customText?: string, imageUrl?: string, sendOptions: CompanionChatSendOptions = {}) {
    const text = (customText !== undefined ? customText : inputText.value).trim()
    if (disposed || (!text && !imageUrl && !sendOptions.image) || options.busy.value
      || (!options.chatReady.value && sendOptions.action !== 'generate-from-image')) return
    await runTurn(beginUserTurn(text, imageUrl, customText, sendOptions), imageUrl, sendOptions)
  }

  async function regenerateMessage(mid: string) {
    if (disposed || options.busy.value || !options.chatReady.value || !options.storage.canWrite()) return
    const characterId = options.activeChar.value, branch = options.storage.branchId(characterId)
    try { await options.storage.refresh() }
    catch { options.onError('对话未能同步，请重试；原回复已保留。'); return }
    if (disposed || options.busy.value || options.activeChar.value !== characterId
      || options.storage.branchId(characterId) !== branch || !options.storage.canWrite()) return
    const history = options.storage.messages(characterId), target = history.at(-1)
    if (!target || target.mid !== mid) { options.onError('请先切换到这条消息所在的剧情末尾。', 'info'); return }
    const userIndex = target.role === 'user' ? history.length - 1
      : history.map(message => message.role).lastIndexOf('user', history.length - 2)
    const user = history[userIndex]
    if (!user) { options.onError('找不到这条回复对应的问题，请重新发送消息。'); return }
    if (options.chatProvider.value === 'muse' && (user.images?.length || /\[图片\]\s*$/.test(user.content))) {
      options.onError('Muse 目前只接收文字，请用文字描述图片。', 'info')
      return
    }
    const regeneration = target.role === 'assistant' ? { replyId: target.replyId || target.mid, previousMid: target.mid } : undefined
    const assistant = regeneration ? options.storage.prepareRegeneration(characterId, mid) : createAssistant()
    if (!assistant) return
    if (!regeneration) {
      history.push(assistant)
      if (!options.storage.save(true, true, [characterId])) { history.pop(); options.onError('对话未能保存，请重试。'); return }
    }
    const turn = captureTurn(characterId, user, assistant, true, regeneration)
    turn.messages = [...history.slice(0, userIndex + 1), assistant]
    await runTurn(turn)
  }

  async function runTurn(turn: ChatTurn, imageUrl?: string, sendOptions: CompanionChatSendOptions = {}) {
    options.onError('')
    const connection = captureConnection(), text = turn.text, turnMid = turn.assistant.mid
    const fallbackState: TurnFallbackState = {
      activeConnection: connection,
      activeFallbackLabel: '',
      fallbackCandidates: null,
      fallbackIndex: 0,
      triedModels: 1,
      notifiedChatGptFailure: false,
    }
    const controller = new AbortController()
    activeRequest = controller
    let attemptController = new AbortController()
    const forwardAbort = () => attemptController.abort(controller.signal.reason)
    controller.signal.addEventListener('abort', forwardAbort, { once: true })
    let watchdog = startTurnWatchdog(attemptController)
    const japaneseVoice = sendOptions.action !== 'generate-from-image' && isLocalStudioHost()
      && connection.provider !== 'muse' && options.voice.wantsJapanese(turn.character.voice)
    const speechState: TurnSpeechState = { separateSpeech: false, spokenThrough: 0 }
    let resetEmotion = () => {}
    const voiceTurn = {
      mid: turn.assistant.mid,
      voice: turn.character.voice,
      character: turn.characterId,
      deferPreparation: japaneseVoice,
    }
    options.voice.startTurn(voiceTurn)
    const ownsRequest = () => activeRequest === controller
    const ownsHistory = () => options.storage.branchId(turn.characterId) === turn.branch
      && options.storage.messages(turn.characterId).includes(turn.assistant) && turn.assistant.mid === turnMid
    const canPresent = () => !disposed && ownsRequest() && options.activeChar.value === turn.characterId
    const checkCurrent = () => {
      if (!ownsRequest() || !ownsHistory()) controller.abort()
      controller.signal.throwIfAborted()
    }
    const report = (message: string) => { watchdog.touch(); if (canPresent()) options.onToolActivity?.(message) }
    const sourceImage = turn.restricted ? undefined : captureCompanionImageSource(
      sendOptions.image || turn.messages.findLast(message => message.images?.length)?.images?.[0],
      sendOptions.imageAuthority, controller)
    let originalImages: ReturnType<typeof import('./chatRegenerationImages')['captureRegenerationImages']> | undefined
    let imageUrls = imageUrl ? [imageUrl] : []
    const toolContext: CompanionToolContext = {
      character: turn.characterId, branch: turn.branch, signal: controller.signal, report, readImage: sourceImage?.read, imageUrl,
      async onDrawingBatch(id) {
        const { retainCompanionImageMessage } = await import('./companionChatTools')
        checkCurrent()
        if (fallbackState.activeConnection.provider !== 'muse' || !turn.messages.some(message => message.drawingBatchId === id)) {
          turn.assistant.drawingBatchId = id
        }
        await retainCompanionImageMessage(options.storage)
        checkCurrent()
        if (options.nearBottom()) options.scrollBottom()
      },
    }
    let toolOrigin: string | undefined
    const syncToolOrigin = (target: ChatConnectionSnapshot) => {
      toolOrigin = undefined
      toolContext.screenDestination = undefined
      if (target.provider === 'chatgpt') {
        toolOrigin = toolContext.screenDestination = 'https://api.openai.com'
      } else {
        try { toolOrigin = toolContext.screenDestination = new URL(target.hostConfig ? target.hostBaseUrl : target.baseUrl).origin } catch { /* Unknown recipients cannot receive screenshots. */ }
      }
    }
    syncToolOrigin(fallbackState.activeConnection)
    const usedTools = new Set<string>()
    const drawingResults = new Map<string, ToolCallResult>()

    try {
      const memories = options.recallMemories(turn.characterId, text)
      if (memories.length) turn.assistant.recalledMemories = [...memories]
      else delete turn.assistant.recalledMemories
      const { buildChatRequestBody, createTurnEmotionTracker } = await abortableTask(() => import('./chatTurnRuntime'), controller.signal)
      checkCurrent()
      const tracker = createTurnEmotionTracker(turn.characterId, delta => {
        if (!speechState.separateSpeech) options.voice.append(delta)
      },
        (emotion, explicit) => {
          if (explicit) options.voice.setTurnEmotion(emotion, true)
          if (canPresent()) options.onStreamEmotion?.(emotion)
        })
      resetEmotion = tracker.reset
      if (turn.restricted) {
        const { captureRegenerationImages } = await abortableTask(() => import('./chatRegenerationImages'), controller.signal)
        checkCurrent()
        originalImages = captureRegenerationImages(turn.user.images || [], controller)
      }
      if (originalImages) {
        if (/\[图片\]\s*$/.test(turn.user.content) && !turn.user.images?.length) {
          throw new Error('原消息没有保存图片，无法重新生成；请重新发送原图。')
        }
        imageUrls = await originalImages.read()
        checkCurrent()
      }
      if (sendOptions.action === 'generate-from-image') {
        const { executeCompanionChatTool, retainCompanionImageMessage } = await abortableTask(() => import('./companionChatTools'), controller.signal)
        checkCurrent()
        const result = await executeCompanionChatTool('generate_image_from_reference', { character: turn.characterId, description: text }, toolContext)
        checkCurrent()
        turn.assistant.content = result.output
        if (result.image) turn.assistant.images = [{ ...result.image }]
        if (result.image) await retainCompanionImageMessage(options.storage, result.image.taskId)
        checkCurrent()
        replyAnnouncement.value = result.output
        options.voice.append(result.output)
        options.voice.finishTurn()
        return
      }
      if (connection.provider === 'api' && connection.apiModel === 'huiyu-local' && !connection.hostConfig && isLocalStudioHost()) {
        if (imageUrls.length) throw new Error('这套起步本地模型尚未准备视觉投影，请先用文字聊天，或选择支持图片的 API')
        const { localSetupApi } = await abortableTask(() => import('@/api/localSetupApi'), controller.signal)
        const result = await localSetupApi.ensureLlama(connection.baseUrl, controller.signal)
        if (!result.ready) {
          const { waitLocalSetupOperation } = await abortableTask(() => import('@/api/localSetupOperation'), controller.signal)
          await waitLocalSetupOperation(result, { signal: controller.signal, onMessage: report })
        }
      }
      const toolsEnabled = !turn.restricted && connection.tools && (connection.provider === 'api' || connection.provider === 'chatgpt') && isLocalStudioHost()
      const searchEnabled = !turn.restricted && connection.webSearch && (connection.provider === 'api' || connection.provider === 'chatgpt') && isLocalStudioHost()
      const museDrawing = !turn.restricted && connection.provider === 'muse' && connection.tools
        && isLocalStudioHost() && hasRuntimeTasks()
      // 工具循环的临时消息（assistant tool_calls / role:tool）只存内存，
      // 不进持久化历史：它们是同一轮对话的中间过程，不应污染聊天记录。
      const roundMessages: Array<Record<string, unknown>> = []
      let toolRounds = 0
      // 视觉轮沿用本次选定的 API；模型是否支持图片由服务商确认。
      let visionRound = Boolean(imageUrls.length)
      if (imageUrls.length) {
        roundMessages.push({
          role: 'user',
          content: [
            { type: 'text', text: text || '（这是发送给你的图片，请结合你的性格给出锐评）' },
            ...imageUrls.map(url => ({ type: 'image_url', image_url: { url } })),
          ],
        })
      }
      while (true) {
        checkCurrent()
        if (usedTools.size) {
          const policy = await loadCompanionToolPermissions(controller.signal)
          if (!connectionMatches(connection) || [...usedTools].some(name => !companionToolAllowed(name, policy))) throw new Error('工具权限或 API 配置已改变，已停止发送工具结果。')
          checkCurrent()
        }
        const hostMode = fallbackState.activeConnection.provider === 'api' && fallbackState.activeConnection.hostConfig
        const useVision = visionRound
        visionRound = false
        const toolCalls: PendingToolCall[] = []
        const roundTextStart = turn.assistant.content.length
        let roundResult: Awaited<ReturnType<typeof streamChatAttempt>>
        try {
          roundResult = await streamChatAttempt({
            turn, imageUrls, hostMode, useVision, toolsEnabled, museDrawing, japaneseVoice,
            toolResultOrigin: usedTools.size ? toolOrigin : undefined,
            roundMessages, activeConnection: fallbackState.activeConnection, activeFallbackLabel: fallbackState.activeFallbackLabel,
            memories, options, attemptSignal: attemptController.signal, watchdog, tracker, speechState, toolCalls, roundTextStart,
            buildChatRequestBody, applyModelWriteback, checkCurrent, canPresent,
          })
        } catch (attemptError) {
          const nextCandidate = await resolveChatFallback({
            attemptError,
            userAborted: controller.signal.aborted,
            attemptAborted: attemptController.signal.aborted || isAbortError(attemptError),
            watchdog, turn, usedToolsSize: usedTools.size, toolCallsLength: toolCalls.length,
            separateSpeech: speechState.separateSpeech, connection, fallbackState, options, checkCurrent,
          })
          if (nextCandidate) {
            syncToolOrigin(fallbackState.activeConnection)
            visionRound = useVision
            tracker.reset()
            if (canPresent()) {
              options.onThinking?.(null)
              options.onToolActivity?.(`当前模型暂不可用，正在切换至 ${nextCandidate.label} 重试…`)
            }
            watchdog.stop()
            controller.signal.removeEventListener('abort', forwardAbort)
            attemptController = new AbortController()
            controller.signal.addEventListener('abort', forwardAbort, { once: true })
            watchdog = startTurnWatchdog(attemptController)
            continue
          }
          throw attemptError
        }

        if (roundResult.drawing) {
          await submitMuseDrawing({
            drawing: roundResult.drawing, connection, connectionMatches, options, toolContext, report, checkCurrent, canPresent,
          })
        }
        if (!toolCalls.length) {
          if (!roundResult.streamedSpeech && roundResult.legacySpeech && turn.assistant.content.slice(roundTextStart).trim()) {
            options.voice.appendJapanese(roundResult.legacySpeech)
            speechState.spokenThrough = turn.assistant.content.length
          }
          break
        }
        toolRounds += 1
        if (toolRounds > MAX_TOOL_ROUNDS) throw new Error('本次工具调用已达到上限，已停止。请缩小任务范围后继续。')
        visionRound = await executeChatToolRound({
          toolCalls, roundReasoning: roundResult.roundReasoning, searchEnabled, toolsEnabled, roundMessages,
          controller, turn, options, toolContext, usedTools, drawingResults,
          streamedSpeech: roundResult.streamedSpeech, speechState, voiceTurn, report, checkCurrent, canPresent,
        })
      }

      // 收尾：空回复兜底、屏幕阅读器播报、配音收轨。
      checkCurrent()
      if (speechState.separateSpeech) options.voice.append(turn.assistant.content.slice(speechState.spokenThrough))
      turn.assistant.content = turn.assistant.content.trim()
      if (turn.restricted && !turn.assistant.content) throw new Error('模型没有返回回复，请重试；已有回复已保留。')
      if (!turn.assistant.drawingBatchId) turn.assistant.content ||= '……'
      if (canPresent() && turn.assistant.content) replyAnnouncement.value = `${turn.character.name}说：${turn.assistant.content}`
      if (canPresent() && fallbackState.activeFallbackLabel) {
        options.onError(`原模型暂不可用，已自动切换至 ${fallbackState.activeFallbackLabel} 完成本次回复。`, 'info', 4500)
      }
      options.voice.finishTurn()
    } catch (error) {
      if (!ownsRequest() || !ownsHistory()) return
      handleChatTurnError({ error, controller, attemptController, sendOptions, turn, options, watchdog, connection, fallbackState, canPresent })
    } finally {
      controller.signal.removeEventListener('abort', forwardAbort)
      sourceImage?.release()
      originalImages?.release()
      watchdog.stop()
      if (ownsRequest()) {
        try {
          if (!ownsHistory()) options.voice.stop({ preserveMessageAudio: true, silent: true })
          if (turn.regeneration) options.storage.finishRegeneration(turn.characterId, turn.regeneration.replyId, turn.regeneration.previousMid)
          options.storage.trim(turn.characterId)
          options.storage.save(true, true, [turn.characterId])
        } finally {
          resetEmotion()
          if (!disposed) { options.onToolActivity?.(null); options.onThinking?.(null) }
          streamingMid.value = ''
          activeRequest = null
          options.setBusy(false)
          if (!disposed && options.nearBottom()) options.scrollBottom()
        }
      }
    }
  }

  function useStarter(text: string) {
    draft.clear()
    inputText.value = text
    options.storage.setDraft(options.activeChar.value, text)
  }

  function onInputChange() {
    draft.schedule(options.activeChar.value, inputText.value)
  }

  function clearDraftInput() {
    draft.clear()
    inputText.value = ''
  }

  function destroy() {
    disposed = true
    draft.dispose(); releaseMaintenance()
    options.storage.setDraft(options.activeChar.value, inputText.value)
    abortCurrentRequest(true, false)
  }

  return {
    inputText,
    streamingMid,
    replyAnnouncement,
    abortCurrentRequest,
    stopEverything,
    sendMessage,
    regenerateMessage,
    useStarter,
    onInputChange,
    clearDraftInput,
    destroy,
  }
}
