<template>
  <article class="companion-chat-window" :data-character="activeChar">
    <header class="desktop-titlebar companion-chat-titlebar">
      <div class="companion-chat-identity">
        <ArchiveIcon name="chat" class="companion-chat-brand-icon" />
        <h1 class="companion-chat-title">与{{ currentCharacter.name }}聊天</h1>
      </div>
      <div class="titlebar-controls">
        <AppearanceButton class="companion-chat-mini" />
        <div class="companion-chat-char-switch" aria-label="切换角色">
          <button
            v-for="id in CHARACTER_IDS"
            :key="id"
            type="button"
            :aria-pressed="activeChar === id ? 'true' : 'false'"
            :class="{ active: activeChar === id }"
            :title="`切换到${id === 'nene' ? '绫地宁宁' : '四季夏目'}`"
            @click="switchCharacter(id)"
          >{{ id === 'nene' ? '宁宁' : '夏目' }}</button>
        </div>
        <button
          class="companion-chat-mini"
          type="button"
          title="打开完整房间（Chat）"
          aria-label="打开完整房间"
          @click="openFullRoom"
        ><ArchiveIcon name="chat" /></button>
        <button
          class="companion-chat-mini"
          type="button"
          title="关闭聊天窗"
          aria-label="关闭聊天窗"
          @click="closeWindow"
        ><ArchiveIcon name="close" /></button>
      </div>
    </header>

    <section class="companion-chat-body" aria-label="桌宠聊天">
      <div class="companion-chat-statusline" role="status" aria-live="polite">
        <i class="companion-chat-status-dot" :data-state="statusDotState" aria-hidden="true"></i>
        <span>{{ statusText }}</span>
        <span v-if="noticeText" class="companion-chat-notice">{{ noticeText }}</span>
        <span v-if="quietHint" class="companion-chat-quiet" title="安静时段静默">
          <ArchiveIcon name="moon" /> 安静时段
        </span>
      </div>

      <div ref="listRef" class="companion-chat-bubbles" role="log" aria-label="最近对话">
        <div v-if="!visibleMessages.length" class="companion-chat-empty">
          <span>{{ currentCharacter.name }}</span>
          <p>{{ currentCharacter.greeting }}</p>
        </div>
        <template v-else>
          <div
            v-for="(msg, index) in visibleMessages"
            :key="msg.mid"
            class="companion-chat-bubble"
            :class="msg.role"
            :data-stopped="msg.stopped ? 'true' : undefined"
          >
            <span>{{ msg.role === 'user' ? '你' : currentCharacter.name }}</span>
            <p>{{ msg.content }}</p>
            <small v-if="index === visibleMessages.length - 1 && liveState.speaking">配音中…</small>
          </div>
          <div v-if="liveState.busy || liveState.thinking" class="companion-chat-typing" role="status">
            <i></i><i></i><i></i>
            <span>{{ liveState.speaking ? '正在配音' : '正在回复' }}</span>
          </div>
        </template>
      </div>

      <div class="companion-chat-composer">
        <div
          v-if="!liveState.chatReady"
          class="companion-chat-setup"
          :data-state="liveState.chatReady === false ? 'warning' : 'normal'"
        >
          <ArchiveIcon name="gear" />
          <span>聊天环境尚未就绪，请在完整房间配置模型/语音。</span>
          <button type="button" class="companion-chat-setup-action" @click="openFullRoom">去配置</button>
        </div>
        <textarea
          ref="inputRef"
          v-model="inputText"
          class="companion-chat-input"
          rows="2"
          maxlength="1200"
          :placeholder="`对${currentCharacter.name}说点什么……`"
          aria-label="桌宠聊天输入"
          @focus="composerFocused = true"
          @blur="composerFocused = false"
          @input="onInput"
          @keydown.enter.exact="submitChatOnEnter($event, onSend)"
        ></textarea>
        <div class="companion-chat-actions">
          <button
            v-if="speechReady"
            class="companion-chat-speech"
            type="button"
            :data-state="speechState"
            :disabled="speechState === 'recognizing' || !liveState.chatReady"
            :title="speechError || '按住说话，松开识别；也可按住 Space'"
            @pointerdown.prevent="onSpeechPress"
            @pointerup="onSpeechRelease"
            @pointercancel="onSpeechCancel"
            @pointerleave="onSpeechLeave"
            @keydown.space.prevent="!$event.repeat && onSpeechPress()"
            @keydown.enter.prevent="!$event.repeat && onSpeechPress()"
            @keyup.space.prevent="onSpeechRelease"
            @keyup.enter.prevent="onSpeechRelease"
            @blur="onSpeechCancel"
          ><ArchiveIcon name="sound" /><span>{{ speechButtonText }}</span></button>
          <button
            v-else
            class="companion-chat-speech companion-chat-speech-config"
            type="button"
            title="配置语音输入"
            @click="speechSettingsOpen = true"
          ><ArchiveIcon name="sound" /><span>语音设置</span></button>
          <button
            v-if="liveState.busy || liveState.speaking"
            class="companion-chat-stop"
            type="button"
            @click="onStop"
          >停止</button>
          <button
            class="companion-chat-send"
            type="button"
            :disabled="!canSend"
            @click="onSend"
          >{{ sending ? '发送中…' : liveState.busy ? '回复中' : '发送' }}</button>
        </div>
        <div v-if="liveState.chatReady || errorText || speechSessionActive" class="companion-chat-meta" aria-live="polite">
          <span>{{ metaText }}</span>
          <span v-if="errorText" class="companion-chat-error">{{ errorText }}</span>
          <span v-if="speechSessionActive" class="companion-chat-continuous">
            连续对话中
            <button type="button" aria-label="结束连续对话" @click="onSpeechSessionEnd">×</button>
          </span>
        </div>
      </div>
    </section>

    <SpeechInputSettings
      v-if="speechSettingsOpen"
      @save="onSpeechSettingsSaved"
      @close="speechSettingsOpen = false"
    />
  </article>
</template>

<script setup lang="ts">
import AppearanceButton from '@/components/AppearanceButton.vue'
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { submitChatOnEnter } from '@/utils/chatInput'
import { usePolling } from '@/composables/usePolling'
import { useRouter } from 'vue-router'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import SpeechInputSettings from '@/components/SpeechInputSettings.vue'
import { CHARACTERS } from '@/config/characters'
import { useChatStorage } from '@/composables/chat/useChatStorage'
import { useVoiceInput } from '@/composables/useVoiceInput'
import { isSpeechInputReady, loadSpeechInputConfig } from '@/utils/speechInputConfig'
import { createSpeechSession } from '@/utils/speechSession'
import { createCompanionBehavior, normalizeCompanionConfig } from '@/utils/companionBehavior'
import { COMPANION_BEHAVIOR_KEY, COMPANION_CHAT_LIVE_KEY } from '@/utils/storageKeys'
import '@/assets/css/companion.css'

const CHARACTER_IDS = ['nene', 'natsume'] as const
type CharacterId = (typeof CHARACTER_IDS)[number]

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
const bridge = window.companionDesktop
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
  (liveState.activeChar === 'nene' || liveState.activeChar === 'natsume') ? liveState.activeChar : storage.state.active,
)
const currentCharacter = computed(() => CHARACTERS[activeChar.value] || CHARACTERS.nene)

const inputText = ref('')
const sending = ref(false)
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
    if (typeof raw.activeChar === 'string' && (raw.activeChar === 'nene' || raw.activeChar === 'natsume')) {
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
      await bridge.chatRelay({ command: 'send', text })
      if (activeChar.value === character && inputText.value.trim() === text) inputText.value = ''
      if (storage.draft(character).trim() === text) storage.setDraft(character, '')
    } catch { listenerError('发送失败，草稿已保留，请重试。') }
    finally { sending.value = false }
  } else {
    listenerError('桌宠桥未连接，无法发送（请在角色窗中打开聊天）。')
  }
}

function onStop() {
  if (bridge) void bridge.chatRelay({ command: 'stop' }).catch(() => listenerError('停止失败，请重试。'))
}

function switchCharacter(id: string) {
  if (!CHARACTER_IDS.includes(id as CharacterId) || id === activeChar.value) return
  if (bridge) {
    void bridge.chatRelay({ command: 'switch-character', character: id }).catch(() => listenerError('角色切换失败，请重试。'))
  } else {
    storage.setActive(id)
    liveState.activeChar = id
  }
}

function openFullRoom() {
  if (bridge) { bridge.openAtelier('/chat'); return }
  // 2026-08-30 UX 审计：无桥（浏览器形态）时这里原来是空操作，页面无任何
  // 路由出口，用户既关不掉也回不去。降级为路由跳转。
  void router.push('/chat')
}

function closeWindow() {
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
  if (source === 'auto' && !speechSession.isSessionActive()) {
    if (speechSession.onWakeText(text)) listenerNotice(`已唤醒${currentCharacter.value.name}，直接对话吧`)
    return
  }
  const action = speechSession.onSessionText(text)
  if (action === 'end') {
    listenerNotice('已退出连续对话')
    return
  }
  if (action === 'submit') {
    inputText.value = text
    if (speechConfig.value.autoSend && canSend.value) onSend()
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
  const shouldListen = speechReady.value
    && speechConfig.value.wakeEnabled
    && liveState.chatReady
    && !liveState.busy
    && !behavior.config().dnd
    && !behavior.inQuietHours()
    && !document.hidden
    && speechState.value !== 'error'
    && speechSession.shouldAutoListen()
  if (shouldListen && !speechAutoListening.value && !speechBusy.value) {
    void speechStart('auto')
  } else if (!shouldListen && speechAutoListening.value) {
    speechStop()
  }
}

function onSpeechPress() {
  if (speechBusy.value || !liveState.chatReady) return
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
  if (speechBusy.value || !liveState.chatReady || document.hidden) return
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

/* —— 自动滚动到底部 —— */
watch([visibleMessages, () => liveState.busy, () => liveState.speaking], () => {
  nextTick(() => {
    const element = listRef.value
    if (element) element.scrollTop = element.scrollHeight
  })
})

/* —— 生命周期 —— */
let visibilitySub = 0
function onVisibilityChange() {
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
  speechSession.applyConfig(speechConfig.value, currentCharacter.value.name)
  reconcileAutoListen()
  window.addEventListener('storage', onStorageChange)
  window.addEventListener('keydown', onWindowKeydown, { passive: false })
  window.addEventListener('keyup', onWindowKeyup, { passive: false })
  window.addEventListener('pointerdown', onDocFocus, { passive: true })
  document.addEventListener('visibilitychange', onVisibilityChange)
  if (bridge?.onVisibilityChanged) visibilitySub = bridge.onVisibilityChanged(reconcileAutoListen)
})

function onStorageChange(event: StorageEvent) {
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
  quietClock.stop()
  window.removeEventListener('resize', resizeComposer)
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
</script>
