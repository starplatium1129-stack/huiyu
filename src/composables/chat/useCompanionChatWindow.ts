import { getDesktopCapabilities } from '../../platform/desktop/capabilities.ts'
import { profileLocalStorage as localStorage } from '../../platform/web/profileStorage.ts'

import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { usePolling } from '../usePolling.ts'
import { useRouter } from 'vue-router'
import {
  DEFAULT_COMPANION_CHARACTER_ID,
  getCompanionCharacterConfig,
} from '../../utils/companionRegistry.ts'
import { useChatStorage } from './useChatStorage.ts'
import { useVoiceInput } from '../useVoiceInput.ts'
import { isSpeechInputReady, loadSpeechInputConfig } from '../../utils/speechInputConfig.ts'
import { createSpeechSession } from '../../utils/speechSession.ts'
import { createCompanionBehavior, normalizeCompanionConfig } from '../../utils/companionBehavior.ts'
import { CHAT_RESET_KEY, COMPANION_BEHAVIOR_KEY, COMPANION_CHAT_LIVE_KEY } from '../../utils/storageKeys.ts'

import { useConversationReading } from './useConversationReading.ts'
import { relayChatTurn } from '../../utils/chatRelayReceipt.ts'

export function useCompanionChatWindow() {

interface ChatLiveState {
  busy: boolean
  thinking: boolean
  speaking: boolean
  activeChar: string
  chatReady: boolean
  ts: number
}

/** 无桥降级：允许纯浏览器里用本地 storage 观看/本地切角色（发送需桌宠桥） */
const storage = useChatStorage(() => { /* 聊天窗静默收集失败即可 */ })
const bridge = getDesktopCapabilities()
/** 浏览器形态（无桥）下 /companion-chat 是死路：window.close() 对非脚本打开的
 *  窗口无效，页面里也没有任何路由出口。这里给一个真正走得通的返回。 */
const router = useRouter()

const liveState = reactive<ChatLiveState>({
  busy: false,
  thinking: false,
  speaking: false,
  activeChar: storage.state.active,
  chatReady: false,
  ts: 0,
})
const activeChar = computed<string>(() =>
  getCompanionCharacterConfig(liveState.activeChar) ? liveState.activeChar : storage.state.active,
)
const currentCharacter = computed(() => {
  const config = getCompanionCharacterConfig(activeChar.value)
    || getCompanionCharacterConfig(DEFAULT_COMPANION_CHARACTER_ID)
  if (!config) throw new Error('No companion character presentation is registered')
  return config
})

const inputText = ref('')
const sending = ref(false)
const windowVisible = ref(true)
const pageHidden = ref(document.hidden)
const windowFocused = ref(document.hasFocus())
let alive = true
let liveInitialized = false
const composerFocused = ref(false)
const listRef = ref<HTMLDivElement>()
const inputRef = ref<HTMLTextAreaElement>()
const speechSettingsOpen = ref(false)
const speechConfig = ref(loadSpeechInputConfig())
const speechSession = createSpeechSession()
const speechSessionState = ref(speechSession.state())
const stopSpeechSessionWatch = speechSession.onChange(() => { speechSessionState.value = speechSession.state() })
const behavior = createCompanionBehavior(readBehaviorConfig())
const quietHint = ref(behavior.inQuietHours())
const quietClock = usePolling({ intervalMs: 30_000, immediate: false, tick: () => {
  quietHint.value = behavior.inQuietHours()
  reconcileAutoListen()
} })

const visibleMessages = computed(() => storage.messages(activeChar.value).slice(-40))
const canSend = computed(() => Boolean(inputText.value.trim()) && !sending.value && !liveState.busy && liveState.chatReady)

const {
  state: speechState,
  errorMessage: speechError,
  supported: speechSupported,
  autoListening: speechAutoListening,
  start: speechStart,
  stop: speechStop,
  cancel: speechCancel,
  release: speechRelease,
} = useVoiceInput({
  config: () => speechConfig.value,
  onText: onSpeechText,
})

const speechReady = computed(() => isSpeechInputReady(speechConfig.value) && speechSupported)
const speechBusy = computed(() => ['acquiring', 'capturing', 'recognizing'].includes(speechState.value))
const replyActive = computed(() => sending.value || liveState.busy || liveState.thinking || liveState.speaking)
const canCapture = computed(() => speechReady.value && liveState.chatReady && !replyActive.value
  && windowVisible.value && !pageHidden.value && windowFocused.value)
const speechButtonDisabled = computed(() => !liveState.chatReady || replyActive.value || speechState.value === 'recognizing')
const speechSessionActive = computed(() => {
  void speechSessionState.value
  return speechSession.isSessionActive()
})
const speechButtonText = computed(() => {
  if (speechState.value === 'acquiring') return '启动中…'
  if (speechState.value === 'capturing') return '松开结束'
  if (speechState.value === 'recognizing') return '识别中…'
  return '按住说话'
})

const statusDotState = computed(() => {
  if (liveState.speaking) return 'speaking'
  if (liveState.busy || liveState.thinking) return 'busy'
  return 'idle'
})
const statusText = computed(() => {
  if (liveState.speaking) return `${currentCharacter.value.name}正在配音`
  if (liveState.busy) return `${currentCharacter.value.name}正在回复…`
  if (liveState.thinking) return '思考中…'
  return `与${currentCharacter.value.name}的对话`
})
const metaText = computed(() => {
  if (!liveState.chatReady) return '聊天环境未就绪'
  if (quietHint.value) return '安静时段内不主动打扰'
  const hint = speechReady.value ? '按住说话 / Space' : '语音输入未配置'
  return hint
})

function readBehaviorConfig() {
  try {
    return normalizeCompanionConfig(JSON.parse(localStorage.getItem(COMPANION_BEHAVIOR_KEY) || 'null'))
  } catch {
    return normalizeCompanionConfig(null)
  }
}

function readLive() {
  try {
    const previousCharacter = activeChar.value
    const raw = JSON.parse(localStorage.getItem(COMPANION_CHAT_LIVE_KEY) || 'null')
    if (!raw || typeof raw !== 'object') return
    liveState.busy = Boolean(raw.busy)
    liveState.thinking = Boolean(raw.thinking)
    liveState.speaking = Boolean(raw.speaking)
    if (getCompanionCharacterConfig(raw.activeChar)) {
      liveState.activeChar = raw.activeChar
    }
    if (typeof raw.chatReady === 'boolean') liveState.chatReady = raw.chatReady
    liveState.ts = Number(raw.ts) || 0
    if (liveInitialized && previousCharacter !== activeChar.value) {
      clearTimeout(draftTimer)
      storage.setDraft(previousCharacter, inputText.value)
      inputText.value = storage.draft(activeChar.value)
    }
  } catch { /* 解析失败保持现状 */ }
}

async function onSend() {
  const text = inputText.value.trim()
  if (!canSend.value) return
  if (bridge) {
    const character = activeChar.value
    clearTimeout(draftTimer)
    storage.setDraft(character, inputText.value)
    sending.value = true
    try {
      await relayChatTurn(bridge, text, character)
      if (activeChar.value === character && inputText.value.trim() === text) inputText.value = ''
      if (storage.draft(character).trim() === text) storage.setDraft(character, '')
    } catch { listenerError('发送失败，草稿已保留，请重试。') }
    finally {
      sending.value = false
      if (alive && !replyActive.value) speechSession.markReplyIdle()
    }
  } else {
    listenerError('桌宠桥未连接，无法发送（请在角色窗中打开聊天）。')
  }
}

function onStop() {
  if (bridge) void bridge.chatRelay({ command: 'stop' }).catch(() => listenerError('停止失败，请重试。'))
}

function switchCharacter(id: string) {
  if (!getCompanionCharacterConfig(id) || id === activeChar.value) return
  if (bridge) {
    void bridge.chatRelay({ command: 'switch-character', character: id }).catch(() => listenerError('角色切换失败，请重试。'))
  } else {
    storage.setActive(id)
    liveState.activeChar = id
  }
}

function openFullRoom() {
  clearTimeout(draftTimer)
  storage.setDraft(activeChar.value, inputText.value)
  speechCancel(); speechSession.endSession()
  if (bridge) { bridge.openAtelier(`/chat?character=${encodeURIComponent(activeChar.value)}`); return }
  // 2026-08-30 UX 审计：无桥（浏览器形态）时这里原来是空操作，页面无任何
  // 路由出口，用户既关不掉也回不去。降级为路由跳转。
  void router.push({ path: '/chat', query: { character: activeChar.value } })
}

function closeWindow() {
  clearTimeout(draftTimer)
  storage.setDraft(activeChar.value, inputText.value)
  speechCancel(); speechSession.endSession()
  // 直接 hide 聊天窗（不触发 window.close → CloseRequested 链路），避免
  // WebView2 内容被卸载、再次打开显示空白白板。
  if (bridge?.hideChatWindow) {
    void bridge.hideChatWindow()
    return
  }
  // 2026-08-30 UX 审计：window.close() 只对脚本打开的窗口生效，浏览器里直接
  // 打开这个地址时它什么都不做——关窗按钮点了没反应，页面又无任何出口。
  // 有历史就后退，没有就回桌宠页。
  if (window.history.length > 1) router.back()
  else void router.push('/companion')
}

const errorText = ref('')
let errorTimer = 0
function listenerError(message: string) {
  errorText.value = message
  clearTimeout(errorTimer)
  errorTimer = window.setTimeout(() => { errorText.value = '' }, 4000) as unknown as number
}

/* —— 语音输入（与 CompanionView 语义一致：manual 长按 + auto 唤醒） —— */
let speechHeldByPointer = false
let speechHeldByKeyboard = false

function onSpeechText(text: string, source: string) {
  if (!alive || !canCapture.value) return
  if (source === 'auto' && !speechSession.isSessionActive()) {
    if (speechSession.onWakeText(text)) listenerNotice(`已唤醒${currentCharacter.value.name}，直接对话吧`)
    return
  }
  const action = speechSession.onSessionText(text)
  if (action === 'end') {
    speechSession.endSession()
    listenerNotice('已退出连续对话')
    return
  }
  if (action === 'submit') {
    inputText.value = text
    if (speechConfig.value.autoSend && canSend.value) void onSend()
    else speechSession.markReplyIdle()
  }
}

const noticeText = ref('')
let noticeTimer = 0
function listenerNotice(message: string) {
  noticeText.value = message
  clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => { noticeText.value = '' }, 3000) as unknown as number
}

function reconcileAutoListen() {
  if (!alive) return
  if (!canCapture.value) {
    cancelSpeechActivity()
    return
  }
  const shouldListen = speechReady.value
    && speechConfig.value.wakeEnabled
    && liveState.chatReady
    && !liveState.busy
    && !behavior.config().dnd
    && !behavior.inQuietHours()
    && speechState.value !== 'error'
    && speechSession.shouldAutoListen()
  if (shouldListen && !speechAutoListening.value && !speechBusy.value) {
    void speechStart('auto')
  } else if (!shouldListen && speechAutoListening.value) {
    speechCancel()
  }
}

function cancelSpeechActivity() {
  speechHeldByPointer = false
  speechHeldByKeyboard = false
  speechCancel()
}

watch(replyActive, active => {
  if (active) { speechSession.markReplyBusy(); cancelSpeechActivity() }
  else speechSession.markReplyIdle()
  reconcileAutoListen()
})
watch([speechState, speechConfig, canCapture, speechSessionState], reconcileAutoListen)

function onSpeechPress() {
  if (speechBusy.value || !canCapture.value) return
  speechHeldByPointer = true
  void speechStart('manual')
}
function onSpeechRelease() {
  if (!speechHeldByPointer) return
  speechHeldByPointer = false
  if (speechState.value === 'acquiring') speechCancel()
  else speechStop()
}
function onSpeechCancel() {
  if (!speechHeldByPointer) return
  speechHeldByPointer = false
  speechCancel()
}
function onSpeechLeave(event: PointerEvent) {
  if (speechHeldByPointer && event.buttons > 0) onSpeechCancel()
}
function onSpeechSessionEnd() {
  speechSession.endSession()
  listenerNotice('已结束连续对话')
  reconcileAutoListen()
}
function onSpeechSettingsSaved() {
  speechConfig.value = loadSpeechInputConfig()
  speechSession.applyConfig(speechConfig.value, currentCharacter.value.name)
  reconcileAutoListen()
  speechSettingsOpen.value = false
}

function onWindowKeydown(event: KeyboardEvent) {
  if (event.key !== ' ' || event.repeat || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return
  const target = event.target
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable)
    || (target instanceof HTMLElement && Boolean(target.closest('button, a, [role="button"]')))) return
  if (speechBusy.value || !canCapture.value) return
  speechHeldByKeyboard = true
  event.preventDefault()
  void speechStart('manual')
}
function onWindowKeyup(event: KeyboardEvent) {
  if (event.key !== ' ' || !speechHeldByKeyboard) return
  speechHeldByKeyboard = false
  event.preventDefault()
  if (speechState.value === 'acquiring') speechCancel()
  else speechStop()
}

/* —— 草稿回填与保存（与角色窗同键位，跨窗可接力） —— */
let draftTimer = 0
function onInput() {
  clearTimeout(draftTimer)
  const value = inputText.value
  const character = activeChar.value
  draftTimer = window.setTimeout(() => storage.setDraft(character, value), 240) as unknown as number
}
function resizeComposer() {
  const input = inputRef.value
  if (!input) return
  input.style.height = 'auto'
  input.style.height = `${Math.min(input.scrollHeight, Math.max(64, Math.min(144, innerHeight * .24)))}px`
}
watch(inputText, () => { void nextTick(resizeComposer) })

const { hasNew, latest } = useConversationReading(listRef, () => visibleMessages.value, activeChar)
const docked = ref(true)
async function startWindowDrag(event: MouseEvent) {
  if (event.button !== 0 || !bridge?.startDragging || event.target instanceof Element && event.target.closest('button, input, select, textarea, a')) return
  event.preventDefault(); event.stopPropagation()
  try {
    if (docked.value) docked.value = await bridge.setChatDocked?.(false) ?? false
    await bridge.startDragging()
  } catch { listenerError('无法移动聊天窗，请重试。') }
}
async function toggleDock() {
  try { docked.value = await bridge?.setChatDocked?.(!docked.value) ?? false }
  catch { listenerError('贴靠未能完成，请重试。') }
}
async function copyMessage(content: string) {
  try { await navigator.clipboard.writeText(content); listenerNotice('已复制') }
  catch { listenerError('复制失败，可以选中文字后复制。') }
}

/* —— 生命周期 —— */
let visibilitySub = 0
function onVisibilityChange() {
  pageHidden.value = document.hidden
  windowFocused.value = document.hasFocus()
  reconcileAutoListen()
}

onMounted(() => {
  quietClock.start()
  document.documentElement.classList.add('companion-mode')
  storage.load()
  readLive()
  inputText.value = storage.draft(activeChar.value)
  liveInitialized = true
  void nextTick(resizeComposer)
  window.addEventListener('resize', resizeComposer)
  window.addEventListener('focus', onVisibilityChange)
  window.addEventListener('blur', onVisibilityChange)
  void Promise.resolve(bridge?.getChatDocked?.()).then(value => { if (typeof value === 'boolean') docked.value = value }).catch(() => {})
  speechSession.applyConfig(speechConfig.value, currentCharacter.value.name)
  reconcileAutoListen()
  window.addEventListener('storage', onStorageChange)
  window.addEventListener('keydown', onWindowKeydown, { passive: false })
  window.addEventListener('keyup', onWindowKeyup, { passive: false })
  window.addEventListener('pointerdown', onDocFocus, { passive: true })
  document.addEventListener('visibilitychange', onVisibilityChange)
  if (bridge?.onVisibilityChanged) visibilitySub = bridge.onVisibilityChanged(visible => {
    windowVisible.value = visible
    onVisibilityChange()
  })
})

function onStorageChange(event: StorageEvent) {
  if (event.key === CHAT_RESET_KEY) {
    clearTimeout(draftTimer)
    inputText.value = ''
    storage.canWrite()
    // canWrite clears in-memory content; do not reload while the publisher is still deleting.
  }
  if (event.key === COMPANION_CHAT_LIVE_KEY) readLive()
  if (event.key === null || event.key === COMPANION_BEHAVIOR_KEY) {
    behavior.setConfig(readBehaviorConfig())
    quietHint.value = behavior.inQuietHours()
    reconcileAutoListen()
  }
}

function onDocFocus() {
  // 角色窗存储事件在后台可能错过 focus 时机；点击即刷新一次
  readLive()
}

onUnmounted(() => {
  alive = false
  quietClock.stop()
  storage.setDraft(activeChar.value, inputText.value)
  window.removeEventListener('resize', resizeComposer)
  window.removeEventListener('focus', onVisibilityChange)
  window.removeEventListener('blur', onVisibilityChange)
  stopSpeechSessionWatch()
  clearTimeout(draftTimer)
  clearTimeout(errorTimer)
  clearTimeout(noticeTimer)
  window.removeEventListener('storage', onStorageChange)
  window.removeEventListener('keydown', onWindowKeydown)
  window.removeEventListener('keyup', onWindowKeyup)
  window.removeEventListener('pointerdown', onDocFocus)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  if (bridge?.offVisibilityChanged && visibilitySub) bridge.offVisibilityChanged(visibilitySub)
  speechHeldByKeyboard = false
  speechHeldByPointer = false
  speechCancel()
  speechRelease()
  speechSession.endSession()
  document.documentElement.classList.remove('companion-mode')
})

watch(activeChar, () => {
  speechHeldByPointer = false
  speechHeldByKeyboard = false
  speechCancel()
  noticeText.value = ''
  speechSession.applyConfig(speechConfig.value, currentCharacter.value.name)
  inputText.value = storage.draft(activeChar.value)
  reconcileAutoListen()
})

return { activeChar, currentCharacter, bridge, switchCharacter, openFullRoom, closeWindow, startWindowDrag, statusDotState, statusText, noticeText, quietHint, listRef, visibleMessages, liveState, inputRef, inputText, composerFocused, onInput, onSend, speechReady, speechState, speechError, speechButtonDisabled, onSpeechPress, onSpeechRelease, onSpeechCancel, onSpeechLeave, speechButtonText, speechSettingsOpen, onStop, canSend, sending, errorText, speechSessionActive, metaText, onSpeechSessionEnd, onSpeechSettingsSaved, hasNew, latest, copyMessage, docked, toggleDock }
}
