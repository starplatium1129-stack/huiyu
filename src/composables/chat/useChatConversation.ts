import type { useChatStorage } from './useChatStorage'
import type { useVoice } from '../useVoice'
import type { ChatUserProfile } from '@/utils/chatUserProfile'
import { createChatTurnConnection, type ChatConnectionOptions } from './chatTurnConnection'
import { runtimeFetch } from '../../platform/runtimeUrl.ts'
import type { CompanionToolResult as ToolCallResult } from './executeCompanionTool'
import { reactive, ref, type Ref, type ComputedRef } from 'vue'
import { createMessageId, type CharacterConfig } from '../../config/characters.ts'
import {
  isAbortError,
  parseNdjsonResponse,
  streamErrorCode,
  streamErrorMessage,
} from '../../utils/stream.ts'
import { isLocalStudioHost } from '../../utils/runtimeEnvironment.ts'
import { registerMaintenanceParticipant } from '@/platform/maintenanceParticipants'
import { createChatDraftPersistence } from './chatDraftPersistence'
import type { ChatMessage } from './chatStorageTypes'
import { MAX_CHAT_DRAWINGS, parseCompanionChatImages, type CompanionChatSendOptions } from '@/types/companionDrawing'
import type { CompanionToolContext } from './companionChatTools'
import { captureCompanionImageSource } from './companionChatImages'
import { startTurnWatchdog } from './chatTurnWatchdog'
import { abortableTask } from '@/utils/abortableTask'
import { loadCompanionToolPermissions, companionToolAllowed } from './useCompanionToolPermissions'
import { hasRuntimeTasks } from '@/api/runtimeTaskAuthority'

type ChatStorage = ReturnType<typeof useChatStorage>
type VoiceController = ReturnType<typeof useVoice>
type TurnMessages = ReturnType<ChatStorage['messages']>

interface ChatConversationOptions extends ChatConnectionOptions {
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

interface PendingToolCall {
  id: string
  name: string
  arguments: string
  thoughtSignature?: string
}

const MAX_TOOL_ROUNDS = 4

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
    regeneration?: { replyId: string; previousMid: string }) {
    const messages = options.storage.messages(characterId)
    replyAnnouncement.value = ''
    streamingMid.value = assistant.mid
    options.scrollBottom()
    options.setBusy(true)
    return { characterId, branch: options.storage.branchId(characterId), sessionId: sessionId(characterId, messages),
      character: options.currentCharacter.value, user, assistant, messages, restricted, regeneration,
      text: restricted ? user.content.replace(/\s*\[图片\]\s*$/, '').trim() : user.content }
  }
  type ChatTurn = ReturnType<typeof captureTurn>

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
    const controller = new AbortController()
    activeRequest = controller
    const watchdog = startTurnWatchdog(controller)
    const japaneseVoice = sendOptions.action !== 'generate-from-image' && isLocalStudioHost()
      && connection.provider !== 'muse' && options.voice.wantsJapanese(turn.character.voice)
    let separateSpeech = false
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
        if (connection.provider !== 'muse' || !turn.messages.some(message => message.drawingBatchId === id)) {
          turn.assistant.drawingBatchId = id
        }
        await retainCompanionImageMessage(options.storage)
        checkCurrent()
        if (options.nearBottom()) options.scrollBottom()
      },
    }
    let toolOrigin: string | undefined
    if (connection.provider === 'chatgpt') {
      toolOrigin = toolContext.screenDestination = 'https://api.openai.com'
    } else {
      try { toolOrigin = toolContext.screenDestination = new URL(connection.hostConfig ? connection.hostBaseUrl : connection.baseUrl).origin } catch { /* Unknown recipients cannot receive screenshots. */ }
    }
    const usedTools = new Set<string>()
    const drawingResults = new Map<string, ToolCallResult>()

    try {
      const memories = options.recallMemories(turn.characterId, text)
      if (memories.length) turn.assistant.recalledMemories = [...memories]
      else delete turn.assistant.recalledMemories
      const { buildChatRequestBody, createTurnEmotionTracker } = await abortableTask(() => import('./chatTurnRuntime'), controller.signal)
      checkCurrent()
      const tracker = createTurnEmotionTracker(turn.characterId, delta => {
        if (!separateSpeech) options.voice.append(delta)
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
      if(connection.provider==='api'&&connection.apiModel==='huiyu-local'&&!connection.hostConfig&&isLocalStudioHost()){
        if(imageUrls.length)throw new Error('这套起步本地模型尚未准备视觉投影，请先用文字聊天，或选择支持图片的 API')
        const {localSetupApi}=await abortableTask(()=>import('@/api/localSetupApi'),controller.signal)
        const result=await localSetupApi.ensureLlama(connection.baseUrl,controller.signal)
        if(!result.ready){
          const {waitLocalSetupOperation}=await abortableTask(()=>import('@/api/localSetupOperation'),controller.signal)
          await waitLocalSetupOperation(result,{signal:controller.signal,onMessage:report})
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
      let spokenThrough = 0
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
        const hostMode = connection.provider === 'api' && connection.hostConfig
        const useVision = visionRound
        visionRound = false
        // DeepSeek V4：思考轮带 tool_calls 时必须回传 reasoning_content
        let roundReasoning = ''
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
            toolResultOrigin: usedTools.size ? toolOrigin : undefined,
            roundMessages,
            messages: turn.messages, connection, restricted: turn.restricted,
            userProfile: options.userProfile.value, memories,
          }),
          signal: controller.signal,
        })

        const toolCalls: PendingToolCall[] = []
        const roundTextStart = turn.assistant.content.length
        let drawing: Record<string, unknown> | undefined
        let speechFirst = false
        let textHasSpeech = false
        let streamedSpeech = false
        let legacySpeech = ''
        await parseNdjsonResponse(response, event => {
          checkCurrent()
          watchdog.touch()
          if (event.type === 'meta' && event.model) {
            applyModelWriteback(event.model, hostMode, useVision, connection)
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
            separateSpeech = true
            speechFirst = event.speechFirst === true
            return
          }
          if (event.type === 'japanese-speech-chunk' && separateSpeech) {
            if (toolCalls.length) return
            const script = event.content?.trim()
            if (speechFirst) textHasSpeech = Boolean(script)
            if (!script || (!speechFirst && !turn.assistant.content.slice(roundTextStart).trim())) return
            if (speechFirst) {
              const unvoiced = turn.assistant.content.slice(spokenThrough)
              if (unvoiced.trim()) {
                options.voice.append(unvoiced)
                options.voice.finishTurn()
              }
            }
            options.voice.appendJapanese(script)
            streamedSpeech = true
            spokenThrough = turn.assistant.content.length
            return
          }
          if (event.type === 'japanese-speech' && separateSpeech) {
            legacySpeech = event.content || ''
            return
          }
          if (event.type !== 'token') return
          if (canPresent()) options.onThinking?.(null)
          tracker.applyTokenDelta(turn.assistant, event.content || '')
          if (textHasSpeech) spokenThrough = turn.assistant.content.length
          if (options.nearBottom()) options.scrollBottom()
        })

        if (drawing) {
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
        if (!toolCalls.length) {
          if (!streamedSpeech && legacySpeech && turn.assistant.content.slice(roundTextStart).trim()) {
            options.voice.appendJapanese(legacySpeech)
            spokenThrough = turn.assistant.content.length
          }
          break
        }
        if (toolCalls.some(call => call.name === 'search_web' ? !searchEnabled : !toolsEnabled)) throw new Error('请求的工具当前未启用，已停止执行。')
        toolRounds += 1
        if (toolRounds > MAX_TOOL_ROUNDS) throw new Error('本次工具调用已达到上限，已停止。请缩小任务范围后继续。')
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
        const { executeSerializedCompanionChatTool, retainCompanionImageMessage } = await abortableTask(() => import('./companionChatTools'), controller.signal)
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
            visionRound = true
          }
        }
        if (canPresent()) options.onToolActivity?.(null)
        if (options.nearBottom()) options.scrollBottom()
        if (streamedSpeech) {
          spokenThrough = turn.assistant.content.length
          options.voice.startTurn(voiceTurn)
        }
      }

      // 收尾：空回复兜底、屏幕阅读器播报、配音收轨。
      checkCurrent()
      if (separateSpeech) options.voice.append(turn.assistant.content.slice(spokenThrough))
      turn.assistant.content = turn.assistant.content.trim()
      if (turn.restricted && !turn.assistant.content) throw new Error('模型没有返回回复，请重试；已有回复已保留。')
      if (!turn.assistant.drawingBatchId) turn.assistant.content ||= '……'
      if (canPresent() && turn.assistant.content) replyAnnouncement.value = `${turn.character.name}说：${turn.assistant.content}`
      options.voice.finishTurn()
    } catch (error) {
      if (!ownsRequest() || !ownsHistory()) return
      const aborted = controller.signal.aborted || isAbortError(error)
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
          if (canPresent()) options.onError(watchdog.sawFirstEvent
            ? '对话长时间无响应，已中断，请重试。'
            : '对话等待超时（长时间未开始），请重试。')
        }
      } else {
        options.voice.stop({ preserveMessageAudio: true, silent: true })
        const code = streamErrorCode(error)
        const sticky = ['CHATGPT_USAGE_LIMIT', 'CHATGPT_REAUTH_REQUIRED', 'CHATGPT_PLAN_NOT_ENABLED', 'CHATGPT_SCOPE_DENIED'].includes(code)
        if (connection.provider === 'chatgpt' && (sticky || code === 'CHATGPT_SELECTION_CHANGED')) {
          options.onChatGptStatusChanged?.()
        }
        if (canPresent()) options.onError(streamErrorMessage(
          error,
          connection.provider === 'muse' ? 'Muse 暂时无法回复，请在聊天设置中检查收信状态。'
            : connection.provider === 'chatgpt' ? 'ChatGPT 订阅对话暂不可用，请检查账号状态与用量限额。'
              : connection.provider === 'api'
                ? 'API 对话暂不可用，请检查地址、模型名和密钥。'
                : '聊天暂不可用，请检查 Ollama。',
        ), 'error', sticky ? 0 : 7000, code)
      }
    } finally {
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
