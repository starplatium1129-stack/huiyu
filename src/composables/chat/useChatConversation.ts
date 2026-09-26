import { runtimeFetch } from '../../platform/runtimeUrl.ts'
import { getDesktopCapabilities } from '../../platform/desktop/capabilities.ts'
import { ref, type ComputedRef, type Ref } from 'vue'
import { createMessageId, type CharacterConfig } from '../../config/characters.ts'
import { useChatStorage } from './useChatStorage.ts'
import { useVoice } from '../useVoice.ts'
import { CLIPROXY_BASE_URL, CLIPROXY_API_KEY, CLIPROXY_DEFAULT_MODEL } from '../../config/chatApi.ts'
import {
  inferEmotion,
  isAbortError,
  parseNdjsonResponse,
  streamErrorMessage,
} from '../../utils/stream.ts'
import { extractMoodTag } from '../../utils/moodTag.ts'
import { hasChatUserProfile, type ChatUserProfile } from '../../utils/chatUserProfile.ts'
import { isLocalStudioHost } from '../../utils/runtimeEnvironment.ts'
import { abortableTask } from '../../utils/abortableTask.ts'

// 2026-08-16 审计：流式对话的两级超时兜底（此前无任何超时，上游挂起=无限 spinner）。
// 首事件超时覆盖排队/连接期；事件间静默覆盖出流后的断流。两者都远大于正常节奏，
// 仅兜底真实挂起。本地 run_command 最长 120s，工具执行期间有 touch 续命。
const CHAT_FIRST_EVENT_TIMEOUT_MS = 180_000
const CHAT_STREAM_IDLE_MS = 180_000
const WATCHDOG_INTERVAL_MS = 4_000

type ChatStorage = ReturnType<typeof useChatStorage>
type VoiceController = ReturnType<typeof useVoice>
/** 单回合捕获的持久化消息数组（storage.messages 的活引用）。 */
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
}

const MAX_TOOL_ROUNDS = 4

/** 单回合流式情绪状态：[mood=xxx] 协议标签主导 + 文本启发式回退的双通道。 */
interface TurnEmotionTracker {
  /** 处理一个 token 增量：更新干净展示文本、情绪通道与配音流。 */
  applyTokenDelta(assistant: { content: string }, delta: string): void
  /** 回合结束（含异常路径）复位情绪通道与原始流。 */
  reset(): void
}

/** 单回合挂起看门狗：无首事件 / 事件间静默超时即中断请求。 */
interface TurnWatchdog {
  touch(): void
  stop(): void
  readonly sawFirstEvent: boolean
  readonly idleTimedOut: boolean
}

/** 工具执行结果（桌面桥与网关端点共用的最小契约）。 */
interface ToolCallResult {
  ok: boolean
  output: string
  imageDataUrl?: string
}

/** 判断一条临时消息是否为多模态图片消息（视觉轮专用）。 */
function isVisionMessage(message: Record<string, unknown>): boolean {
  return Array.isArray(message.content)
    && (message.content as Array<{ type?: string }>).some(part => part.type === 'image_url')
}

export function useChatConversation(options: ChatConversationOptions) {
  const inputText = ref('')
  const streamingMid = ref('')
  const replyAnnouncement = ref('')
  let activeRequest: AbortController | null = null
  let draftTimer = 0

  function abortCurrentRequest(silent = false) {
    if (!activeRequest) return false
    activeRequest.abort()
    activeRequest = null
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

  // ── Pipeline 步骤①：持久化本回合 ─────────────────────────────────────
  // 用户消息入库 + 记忆召回 + 助手占位，随后进入流式就绪状态。
  // 返回的 messages 是存储层的活引用：catch 分支据此移除失败占位。
  function beginUserTurn(text: string, imageUrl: string | undefined, customText?: string) {
    const characterId = options.activeChar.value
    const messages = options.storage.messages(characterId)
    replyAnnouncement.value = ''
    messages.push({
      role: 'user',
      content: imageUrl ? `${text || '（发送了图片）'} [图片]` : text,
      mid: createMessageId(),
      stopped: false,
    })
    options.storage.trim(characterId)
    const recalledList = options.recallMemories(characterId, text)
    const assistant = {
      role: 'assistant' as const,
      content: '',
      mid: createMessageId(),
      stopped: false,
      ...(recalledList && recalledList.length > 0 ? { recalledMemories: recalledList } : {}),
    }
    messages.push(assistant)
    options.storage.save()
    if (customText === undefined) {
      clearTimeout(draftTimer)
      inputText.value = ''
      options.storage.setDraft(characterId, '')
    }
    streamingMid.value = assistant.mid
    options.scrollBottom()
    options.setBusy(true)
    return { characterId, text, imageUrl, messages, assistant }
  }

  // ── Pipeline 步骤②：单回合流式情绪跟踪器 ────────────────────────────
  function createTurnEmotionTracker(characterId: string): TurnEmotionTracker {
    // 情绪双通道：本回合出现过协议标签（[mood=xxx]）后协议主导情绪，
    // 文本启发式整回合让位，避免两条通道互相覆盖。
    const emotionState = { value: 'neutral', moodTagged: false }
    // 本回合原始流（含未闭合标签），与干净展示文本分离累积。
    const streamState = { rawContent: '' }

    function maybeStreamEmotion(replyText: string) {
      if (!options.onStreamEmotion || replyText.length < 4) return
      const emotion = inferEmotion(replyText, characterId)
      if (emotion !== emotionState.value) {
        emotionState.value = emotion
        options.onStreamEmotion(emotion)
      }
    }

    return {
      applyTokenDelta(assistant, delta) {
        const prevCleanLen = assistant.content.length
        // 原始流单独累积（含未闭合标签），展示/历史/配音只吃剥离后的干净文本；
        // 不能用 cleanText 反推 raw，否则被剥离的标签前缀会在下一 token 错位。
        streamState.rawContent += delta
        const extracted = extractMoodTag(streamState.rawContent)
        assistant.content = extracted.cleanText
        if (extracted.emotion) {
          emotionState.moodTagged = true
          if (extracted.emotion !== emotionState.value) {
            emotionState.value = extracted.emotion
            options.onStreamEmotion?.(extracted.emotion)
          }
        } else if (!emotionState.moodTagged) {
          maybeStreamEmotion(assistant.content)
        }
        options.voice.append(extracted.cleanText.slice(prevCleanLen))
      },
      reset() {
        if (options.onStreamEmotion && emotionState.value !== 'neutral') {
          emotionState.value = 'neutral'
          options.onStreamEmotion('neutral')
        }
        emotionState.moodTagged = false
        streamState.rawContent = ''
      },
    }
  }

  // ── Pipeline 步骤③：挂起看门狗 ───────────────────────────────────────
  function startTurnWatchdog(controller: AbortController): TurnWatchdog {
    // 2026-08-16 审计：挂起兜底看门狗——无首事件 / 事件间长时间静默即中断，
    // 避免上游挂起时无限 spinner（idleTimedOut 区分用户主动停止与超时中断）。
    const state = { firstEventAt: 0, idleTimedOut: false, lastEventAt: Date.now() }
    const handle = window.setInterval(() => {
      const silentFor = Date.now() - state.lastEventAt
      if ((!state.firstEventAt && silentFor > CHAT_FIRST_EVENT_TIMEOUT_MS)
        || (state.firstEventAt && silentFor > CHAT_STREAM_IDLE_MS)) {
        state.idleTimedOut = true
        controller.abort()
      }
    }, WATCHDOG_INTERVAL_MS)
    return {
      touch() {
        const now = Date.now()
        if (!state.firstEventAt) state.firstEventAt = now
        state.lastEventAt = now
      },
      stop() {
        window.clearInterval(handle)
      },
      get sawFirstEvent() {
        return Boolean(state.firstEventAt)
      },
      get idleTimedOut() {
        return state.idleTimedOut
      },
    }
  }

  // ── Pipeline 步骤④：单个工具执行（fallible，异常由调用方转译为失败结果）──
  async function executeToolCall(call: PendingToolCall, signal: AbortSignal): Promise<ToolCallResult> {
    signal.throwIfAborted()
    let parsedArgs: Record<string, unknown> = {}
    try {
      parsedArgs = JSON.parse(call.arguments || '{}')
    } catch {
      return { ok: false, output: '工具参数不是有效 JSON，请修正后重试。' }
    }
    if (!parsedArgs || typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) {
      return { ok: false, output: '工具参数必须是 JSON 对象。' }
    }
    let result: ToolCallResult
    if (getDesktopCapabilities()) {
      result = await abortableTask(() => getDesktopCapabilities()!.runTool(call.name, parsedArgs, { signal }), signal)
    } else {
      const res = await runtimeFetch('/api/desktop-tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        // adultEnabled 是传输层授权信号（网关 fail-closed 双门的第二道）：
        // 仅本机直连视为已授权，与模型可控的 args 隔离。
        body: JSON.stringify({ name: call.name, args: parsedArgs, adultEnabled: isLocalStudioHost() }),
      })
      result = await res.json()
      if (!res.ok) return { ok: false, output: String((result as unknown as { error?: string }).error || `工具请求失败（${res.status}）`) }
    }
    signal.throwIfAborted()
    result.output = typeof result.output === 'string' ? result.output : (result.ok ? '工具已完成。' : '工具执行失败，未返回详情。')
    return result
  }

  // ── Pipeline 步骤⑤：meta 模型名写回 ─────────────────────────────────
  function applyModelWriteback(rawModel: unknown, hostMode: boolean, useVision: boolean) {
    // 视觉轮（临时切到 Gemini 看图）的模型名不写回用户配置
    if (options.chatProvider.value === 'api' && !hostMode && !useVision) {
      options.apiModel.value = String(rawModel)
      void Promise.resolve(options.storage.setApiSettings({
        baseUrl: options.apiBaseUrl.value,
        model: options.apiModel.value,
        apiKey: options.apiKey.value,
      })).catch(() => options.onError('模型配置未能安全保存，当前回复不受影响，请稍后重试。'))
    } else if (options.chatProvider.value !== 'api' || hostMode) {
      options.currentModel.value = String(rawModel)
      options.storage.setModel(options.currentModel.value)
    }
  }

  // ── Pipeline 步骤⑥：一轮回合的 /api/chat 请求体组装 ──────────────────
  function buildChatRequestBody(args: {
    characterId: string
    text: string
    imageUrl: string | undefined
    hostMode: boolean
    useVision: boolean
    toolsEnabled: boolean
    roundMessages: Array<Record<string, unknown>>
    messages: TurnMessages
  }): string {
    const { characterId, text, imageUrl, hostMode, useVision, toolsEnabled, roundMessages, messages } = args
    // 若用户配置的模型名包含 gemini/gpt-4/qwen-vl 等视觉模型，或用户有独立配置 API，则优先走用户当前的 API
    const userHasVision = /gemini|gpt-4|qwen-vl|claude/i.test(options.apiModel.value)
    const userApi = {
      baseUrl: options.apiBaseUrl.value,
      model: options.apiModel.value,
      apiKey: options.apiKey.value,
    }
    const visionApi = userHasVision || options.apiKey.value
      ? userApi
      : { baseUrl: CLIPROXY_BASE_URL, model: CLIPROXY_DEFAULT_MODEL, apiKey: CLIPROXY_API_KEY }
    const historyList = (useVision && imageUrl)
      ? messages.slice(0, -2).map(message => ({ role: message.role, content: message.content }))
      : messages.slice(0, -1).map(message => ({ role: message.role, content: message.content }))
    return JSON.stringify({
      character: characterId,
      provider: options.chatProvider.value,
      model: hostMode ? '' : options.currentModel.value,
      api: !hostMode && options.chatProvider.value === 'api' ? (useVision ? visionApi : userApi) : undefined,
      hostConfig: hostMode || undefined,
      webSearch: options.chatProvider.value === 'api' && options.webSearchEnabled.value,
      companionTools: toolsEnabled || undefined,
      reasoning: options.reasoning.value,
      userProfile: hasChatUserProfile(options.userProfile.value) ? options.userProfile.value : undefined,
      memories: options.recallMemories(characterId, text),
      messages: [
        ...historyList,
        // 文本轮（回到 DeepSeek 等）不带图片消息：纯文本模型收到
        // image_url 会直接报错；图片已由视觉轮（Gemini）看过，
        // tool 结果里的摘要文本足够衔接上下文
        ...(useVision ? roundMessages : roundMessages.filter(message => !isVisionMessage(message))),
      ],
    })
  }

  async function sendMessage(customText?: string, imageUrl?: string) {
    const text = (customText !== undefined ? customText : inputText.value).trim()
    if ((!text && !imageUrl) || options.busy.value || !options.chatReady.value) return
    options.onError('')
    options.voice.ensureAudioContext()

    const turn = beginUserTurn(text, imageUrl, customText)

    const controller = new AbortController()
    activeRequest = controller
    const watchdog = startTurnWatchdog(controller)
    options.voice.startTurn({
      mid: turn.assistant.mid,
      voice: options.currentCharacter.value.voice,
      character: turn.characterId,
    })
    const tracker = createTurnEmotionTracker(turn.characterId)

    try {
      const toolsEnabled = options.companionTools.value && options.chatProvider.value === 'api'
      // 工具循环的临时消息（assistant tool_calls / role:tool）只存内存，
      // 不进持久化历史：它们是同一轮对话的中间过程，不应污染聊天记录。
      const roundMessages: Array<Record<string, unknown>> = []
      let toolRounds = 0
      // 视觉轮：带有 imageUrl 或 read_image 成功后的下一轮改用本地 Gemini（视觉模型）发图，
      // 看完成回到用户配置的聊天模型继续对话。
      let visionRound = Boolean(imageUrl)
      if (imageUrl) {
        roundMessages.push({
          role: 'user',
          content: [
            { type: 'text', text: text || '（这是发送给你的图片，请结合你的性格给出锐评）' },
            { type: 'image_url', image_url: { url: imageUrl } },
          ],
        })
      }
      while (true) {
        controller.signal.throwIfAborted()
        const hostMode = options.chatProvider.value === 'api' && options.useHostConfig.value
        const useVision = visionRound && options.chatProvider.value === 'api' && !hostMode
        visionRound = false
        // DeepSeek V4：思考轮带 tool_calls 时必须回传 reasoning_content
        let roundReasoning = ''
        const response = await runtimeFetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: buildChatRequestBody({
            characterId: turn.characterId,
            text,
            imageUrl,
            hostMode,
            useVision,
            toolsEnabled,
            roundMessages,
            messages: turn.messages,
          }),
          signal: controller.signal,
        })

        const toolCalls: PendingToolCall[] = []
        await parseNdjsonResponse(response, async event => {
          controller.signal.throwIfAborted()
          watchdog.touch()
          if (event.type === 'meta' && event.model) {
            applyModelWriteback(event.model, hostMode, useVision)
          }
          if (event.type === 'tool-call') {
            if (event.id && event.name) {
              toolCalls.push({ id: event.id, name: event.name, arguments: String(event.arguments || '{}') })
            }
            return
          }
          if (event.type === 'reasoning') {
            roundReasoning += event.content || ''
            options.onThinking?.(event.content || '')
            return
          }
          if (event.type !== 'token') return
          options.onThinking?.(null)
          tracker.applyTokenDelta(turn.assistant, event.content || '')
          if (options.nearBottom()) options.scrollBottom()
        })

        if (!toolCalls.length) break
        if (!toolsEnabled) throw new Error('当前未启用桌宠工具，已停止执行。')
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
          })),
        })
        for (const call of toolCalls) {
          controller.signal.throwIfAborted()
          watchdog.touch()
          options.onToolActivity?.(`正在执行 ${call.name}…`)
          let result: ToolCallResult
          try {
            result = await executeToolCall(call, controller.signal)
          } catch (error) {
            if (controller.signal.aborted) throw error
            result = { ok: false, output: error instanceof Error ? error.message : String(error) }
          }
          controller.signal.throwIfAborted()
          roundMessages.push({ role: 'tool', tool_call_id: call.id, content: result.output.slice(0, 60000) })
          // read_image 成功时把图片作为多模态 user 消息附加，供视觉模型理解；
          // 下一轮自动切到本地 Gemini 视觉轮，看完成回到原聊天模型
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
        options.onToolActivity?.(null)
        if (options.nearBottom()) options.scrollBottom()
      }

      // 收尾：空回复兜底、屏幕阅读器播报、配音收轨。
      turn.assistant.content = turn.assistant.content.trim() || '……'
      replyAnnouncement.value = `${options.currentCharacter.value.name}说：${turn.assistant.content}`
      options.voice.finishTurn()
    } catch (error) {
      // 中断时保留已收到的内容，避免读到一半的回复突然消失。
      turn.assistant.content = turn.assistant.content.trim()
      turn.assistant.stopped = Boolean(turn.assistant.content)
      if (!turn.assistant.content) {
        const index = turn.messages.indexOf(turn.assistant)
        if (index >= 0) turn.messages.splice(index, 1)
      }
      if (isAbortError(error)) {
        if (watchdog.idleTimedOut) {
          // 超时中断：与用户主动停止不同，按失败处理并给出可理解的提示。
          options.voice.stop({ preserveMessageAudio: true, silent: true })
          options.onError(watchdog.sawFirstEvent
            ? '对话长时间无响应，已中断，请重试。'
            : '对话等待超时（长时间未开始），请重试。')
        }
      } else {
        options.voice.stop({ preserveMessageAudio: true, silent: true })
        options.onError(streamErrorMessage(
          error,
          options.chatProvider.value === 'api'
            ? 'API 对话暂不可用，请检查地址、模型名和密钥。'
            : '聊天暂不可用，请检查 Ollama。',
        ))
      }
    } finally {
      watchdog.stop()
      tracker.reset()
      options.onToolActivity?.(null)
      options.onThinking?.(null)
      options.storage.trim(turn.characterId)
      options.storage.save()
      streamingMid.value = ''
      if (activeRequest === controller) activeRequest = null
      options.setBusy(false)
      options.scrollBottom()
    }
  }

  function useStarter(text: string) {
    inputText.value = text
    options.storage.setDraft(options.activeChar.value, text)
  }

  function onInputChange() {
    clearTimeout(draftTimer)
    const characterId = options.activeChar.value
    const value = inputText.value
    draftTimer = window.setTimeout(() => options.storage.setDraft(characterId, value), 240) as unknown as number
  }

  function clearDraftInput() {
    clearTimeout(draftTimer)
    inputText.value = ''
  }

  function destroy() {
    clearTimeout(draftTimer)
    options.storage.setDraft(options.activeChar.value, inputText.value)
    abortCurrentRequest(true)
  }

  return {
    inputText,
    streamingMid,
    replyAnnouncement,
    abortCurrentRequest,
    stopEverything,
    sendMessage,
    useStarter,
    onInputChange,
    clearDraftInput,
    destroy,
  }
}
