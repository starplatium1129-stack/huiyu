import { runtimeFetch } from '../../platform/runtimeUrl.ts'
import type { CompanionToolResult as ToolCallResult } from '@/api/companionToolsApi'
import { reactive, ref, type ComputedRef, type Ref } from 'vue'
import { createMessageId, type CharacterConfig } from '../../config/characters.ts'
import { useChatStorage } from './useChatStorage.ts'
import { useVoice } from '../useVoice.ts'
import {
  isAbortError,
  parseNdjsonResponse,
  streamErrorMessage,
} from '../../utils/stream.ts'
import type { ChatUserProfile } from '../../utils/chatUserProfile.ts'
import { isLocalStudioHost } from '../../utils/runtimeEnvironment.ts'
import { registerMaintenanceParticipant } from '@/platform/maintenanceParticipants'
import { createChatDraftPersistence } from './chatDraftPersistence'
import type { ChatMessage } from './chatStorageTypes'
import { parseCompanionChatImage, type CompanionChatSendOptions } from '@/types/companionDrawing'
import type { CompanionToolContext } from './companionChatTools'
import { captureCompanionImageSource } from './companionChatImages'
import { startTurnWatchdog } from './chatTurnWatchdog'
import { abortableTask } from '@/utils/abortableTask'
import { loadCompanionToolPermissions, companionToolAllowed } from './useCompanionToolPermissions'

type ChatStorage = ReturnType<typeof useChatStorage>
type VoiceController = ReturnType<typeof useVoice>
/** A normal turn holds live history; regeneration captures only its question's prefix. */
type TurnMessages = ReturnType<ChatStorage['messages']>

interface ChatConversationOptions {
  storage: ChatStorage
  voice: VoiceController
  activeChar: Ref<string>
  currentCharacter: ComputedRef<CharacterConfig>
  busy: Ref<boolean>
  chatReady: ComputedRef<boolean>
  chatProvider: Ref<'local' | 'api'>
  currentModel: Ref<string>
  apiBaseUrl: Ref<string>
  hostApiBaseUrl?: Ref<string>
  apiModel: Ref<string>
  apiKey: Ref<string>
  webSearchEnabled: Ref<boolean>
  /** 使用站主托管配置（访客模式）：前端不带 key，服务端代填 */
  useHostConfig: Ref<boolean>
  /** 启用桌宠本地工具（companionTools）：仅桌面应用 + API 模式生效 */
  companionTools: Ref<boolean>
  /** 模型推理强度（off/low/medium/high，用户可调；仅 API 模式生效） */
  reasoning: Ref<'off' | 'low' | 'medium' | 'high'>
  userProfile: Ref<ChatUserProfile>
  recallMemories: (character: string, query: string) => string[]
  setBusy: (value: boolean) => void
  onError: (message: string, kind?: string, timeout?: number) => void
  /** 流式回复文本驱动情绪（无配音时替代 TTS 情绪通道）；情绪变化才回调 */
  onStreamEmotion?: (emotion: string) => void
  /** 工具执行活动指示（null 表示本轮工具全部结束） */
  onToolActivity?: (activity: string | null) => void
  /** 思考过程进行中（收到 reasoning 增量）；第一个正文 token 到达时以 null 结束 */
  onThinking?: (thinking: string | null) => void
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
    const user: ChatMessage = { role: 'user', content: imageUrl || sendOptions.image ? `${text || '（发送了图片）'} [图片]` : text,
      mid: createMessageId(), stopped: false, ...(sendOptions.image ? { images: [{ ...sendOptions.image }] } : {}) }
    messages.push(user)
    options.storage.trim(characterId)
    const assistant = createAssistant()
    messages.push(assistant)
    options.storage.save()
    if (customText === undefined) {
      draft.clear()
      inputText.value = ''
      options.storage.setDraft(characterId, '')
    }
    const turn = captureTurn(characterId, user, assistant)
    turn.text = text
    return turn
  }

  function captureConnection() {
    return { provider: options.chatProvider.value, currentModel: options.currentModel.value,
      baseUrl: options.apiBaseUrl.value, apiModel: options.apiModel.value, apiKey: options.apiKey.value,
      hostConfig: options.useHostConfig.value, webSearch: options.webSearchEnabled.value,
      tools: options.companionTools.value, reasoning: options.reasoning.value, hostBaseUrl: options.hostApiBaseUrl?.value || '' }
  }
  type TurnConnection = ReturnType<typeof captureConnection>
  const connectionMatches = (connection: TurnConnection) => {
    const live = captureConnection()
    return (Object.keys(connection) as Array<keyof TurnConnection>).every(key => live[key] === connection[key])
  }

  // A stream may canonicalize its own model, but never a newer connection draft.
  function applyModelWriteback(rawModel: unknown, hostMode: boolean, useVision: boolean, connection: TurnConnection) {
    if (connection.provider === 'api' && !hostMode && !useVision && String(rawModel) === connection.apiModel) return
    const ownsDraft = connectionMatches(connection)
    if (connection.provider === 'api' && !hostMode && !useVision) {
      connection.apiModel = String(rawModel)
      if (!ownsDraft) return
      options.apiModel.value = connection.apiModel
      void Promise.resolve(options.storage.setApiSettings({
        baseUrl: connection.baseUrl, model: connection.apiModel, apiKey: connection.apiKey,
      }, 'model')).catch(() => { if (connectionMatches(connection)) options.onError('模型配置未能安全保存，当前回复不受影响，请稍后重试。') })
    } else if (connection.provider !== 'api' || hostMode) {
      connection.currentModel = String(rawModel)
      if (!ownsDraft) return
      options.currentModel.value = connection.currentModel
      options.storage.setModel(connection.currentModel)
    }
  }

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
    const regeneration = target.role === 'assistant' ? { replyId: target.replyId || target.mid, previousMid: target.mid } : undefined
    const assistant = regeneration ? options.storage.prepareRegeneration(characterId, mid) : createAssistant()
    if (!assistant) return
    if (!regeneration) {
      history.push(assistant)
      if (!options.storage.save()) { history.pop(); options.onError('对话未能保存，请重试。'); return }
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
    let resetEmotion = () => {}
    options.voice.startTurn({
      mid: turn.assistant.mid,
      voice: turn.character.voice,
      character: turn.characterId,
    })
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
      sendOptions.image || [...turn.messages].reverse().flatMap(message => message.images || [])[0], sendOptions.imageAuthority, controller)
    let originalImages: ReturnType<typeof import('./chatRegenerationImages')['captureRegenerationImages']> | undefined
    let imageUrls = imageUrl ? [imageUrl] : []
    const toolContext: CompanionToolContext = { character: turn.characterId, signal: controller.signal, report, readImage: sourceImage?.read, imageUrl,
      search: connection.hostConfig ? { hostConfig: true } : { chatApi: { baseUrl: connection.baseUrl, apiKey: connection.apiKey } } }
    let toolOrigin: string | undefined
    try { toolOrigin = toolContext.screenDestination = new URL(connection.hostConfig ? connection.hostBaseUrl : connection.baseUrl).origin } catch { /* Unknown recipients cannot receive screenshots. */ }
    const usedTools = new Set<string>()
    const drawingResults = new Map<string, ToolCallResult>()

    try {
      const memories = options.recallMemories(turn.characterId, text)
      if (memories.length) turn.assistant.recalledMemories = [...memories]
      else delete turn.assistant.recalledMemories
      const { buildChatRequestBody, createTurnEmotionTracker } = await abortableTask(() => import('./chatTurnRuntime'), controller.signal)
      checkCurrent()
      const tracker = createTurnEmotionTracker(turn.characterId, options.voice.append,
        emotion => { if (canPresent()) options.onStreamEmotion?.(emotion) })
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
      const toolsEnabled = !turn.restricted && connection.tools && connection.provider === 'api' && isLocalStudioHost()
      const searchEnabled = !turn.restricted && connection.webSearch && connection.provider === 'api' && isLocalStudioHost()
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
            toolResultOrigin: usedTools.size ? toolOrigin : undefined,
            roundMessages,
            messages: turn.messages, connection, restricted: turn.restricted,
            userProfile: options.userProfile.value, memories,
          }),
          signal: controller.signal,
        })

        const toolCalls: PendingToolCall[] = []
        await parseNdjsonResponse(response, async event => {
          checkCurrent()
          watchdog.touch()
          if (event.type === 'meta' && event.model) {
            applyModelWriteback(event.model, hostMode, useVision, connection)
          }
          if (event.type === 'tool-call') {
            if (event.id && event.name) {
              toolCalls.push({ id: event.id, name: event.name, arguments: String(event.arguments || '{}'), thoughtSignature: event.thoughtSignature })
            }
            return
          }
          if (event.type === 'reasoning') {
            roundReasoning += event.content || ''
            if (canPresent()) options.onThinking?.(event.content || '')
            return
          }
          if (event.type !== 'token') return
          if (canPresent()) options.onThinking?.(null)
          tracker.applyTokenDelta(turn.assistant, event.content || '')
          if (options.nearBottom()) options.scrollBottom()
        })

        if (!toolCalls.length) break
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
          if (result.image) {
            const image = parseCompanionChatImage(result.image)
            if (image && !turn.assistant.images?.some(existing => existing.taskId === image.taskId && existing.path === image.path)) {
              turn.assistant.images = [...(turn.assistant.images || []), image].slice(-4)
              if (!turn.assistant.content.trim()) turn.assistant.content = result.output
            }
            if (image) await retainCompanionImageMessage(options.storage, image.taskId)
            checkCurrent()
          }
          roundMessages.push({ role: 'tool', tool_call_id: call.id, content: result.output.slice(0, 60000) })
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
      }

      // 收尾：空回复兜底、屏幕阅读器播报、配音收轨。
      checkCurrent()
      turn.assistant.content = turn.assistant.content.trim()
      if (turn.restricted && !turn.assistant.content) throw new Error('模型没有返回回复，请重试；已有回复已保留。')
      turn.assistant.content ||= '……'
      if (canPresent()) replyAnnouncement.value = `${turn.character.name}说：${turn.assistant.content}`
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
      if (!turn.assistant.content && !turn.regeneration) {
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
        if (canPresent()) options.onError(streamErrorMessage(
          error,
          connection.provider === 'api'
            ? 'API 对话暂不可用，请检查地址、模型名和密钥。'
            : '聊天暂不可用，请检查 Ollama。',
        ))
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
          options.storage.save()
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
