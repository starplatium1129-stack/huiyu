<template>
  <article class="chat-page">
    <header class="chat-head">
      <div>
        <h1 class="chat-title">角色房间 <span>静かな対話室</span></h1>
        <p class="chat-subtitle">让宁宁或夏目陪你聊一会儿。对谈、声线与温暖记忆，都安静珍藏于本机。</p>
      </div>
      <div class="chat-actions">
        <button class="btn btn-ghost" type="button" @click="clearCharacterConversation">新对话</button>
        <!-- 次要操作收进「更多」菜单：主操作只留「新对话」，破坏性操作入菜单并标危险色 -->
        <div ref="actionsMoreRef" class="chat-actions-more" @focusout="onRoomActionFocusout">
          <button class="btn btn-ghost chat-more-trigger" type="button"
            :aria-expanded="moreOpen ? 'true' : 'false'" aria-haspopup="menu"
            @keydown.down.prevent="focusRoomAction(0)" @keydown.up.prevent="focusRoomAction(-1)"
            @click="moreOpen = !moreOpen">更多<span class="chat-more-caret" aria-hidden="true">{{ moreOpen ? '▴' : '▾' }}</span></button>
          <FluidTransition>
            <div v-if="moreOpen" class="chat-more-menu" role="menu" aria-label="更多房间操作" @keydown="navigateRoomActions">
              <button class="chat-more-item is-danger" role="menuitem" type="button"
                @click="runRoomAction(() => clearAllMemory())">清除聊天记忆</button>
              <button class="chat-more-item" role="menuitem" type="button"
                @click="runRoomAction(() => { archiveOpen = !archiveOpen })">记忆归档</button>
              <button class="chat-more-item" role="menuitem" type="button"
                @click="runRoomAction(() => { memoryOpen = !memoryOpen })">长期记忆</button>
              <button class="chat-more-item" role="menuitem" type="button"
                @click="runRoomAction(() => { profileOpen = !profileOpen })">我的档案</button>
            </div>
          </FluidTransition>
        </div>
      </div>
    </header>

    <FluidTransition>
<ChatArchivePanel
      v-if="archiveOpen"
      :storage="storage"
      :active-char="activeChar"
      @close="archiveOpen = false"
      @notice="(message, kind) => setError(message, kind || 'info', 4500)"
    />
</FluidTransition>

    <FluidTransition>
<ChatUserProfilePanel
      v-if="profileOpen"
      :profile="userProfile"
      @save="onUserProfileSave"
      @close="profileOpen = false"
    />
</FluidTransition>

    <FluidTransition>
<ChatMemoryPanel
      v-if="memoryOpen"
      :items="currentMemories"
      :character-name="currentCharacter.name"
      @update="updateMemory"
      @delete="deleteMemory"
      @close="memoryOpen = false"
    />
</FluidTransition>

    <section class="chat-layout" aria-label="角色聊天">
      <ChatCharacterStage
        ref="characterStageRef"
        :active-id="activeChar"
        :character="currentCharacter"
        :speaking="isSpeaking"
        :volume="volume"
        :chat-status-text="chatStatusText"
        :status-kind="statusKind"
        :auto-load="storage.state.settings.live2dEnabled"
        :outfit="storage.live2dOutfit(activeChar)"
        @select="switchCharacter"
        @live2d-enabled="storage.setLive2dEnabled"
        @outfit-changed="storage.setLive2dOutfit(activeChar, $event)"
      />

      <section class="conversation-card">
        <div class="conversation-head">
          <strong>和{{ currentCharacter.name }}的房间</strong>
          <details class="room-model-settings"><summary>对话设置</summary><div class="model-controls">
            <div class="provider-switch" role="group" aria-label="对话模型来源">
              <button type="button" :class="{ active: chatProvider === 'local' }"
                :aria-pressed="chatProvider === 'local'"
                :disabled="busy" @click="setChatProvider('local')">本地模型</button>
              <button type="button" :class="{ active: chatProvider === 'api' }"
                :aria-pressed="chatProvider === 'api'"
                :disabled="busy" @click="setChatProvider('api')">自定义 API</button>
            </div>
            <template v-if="chatProvider === 'local'">
              <select class="model-select" v-model="currentModel"
                :disabled="busy || !ollamaOnline" aria-label="选择本地聊天模型">
                <option v-if="!ollamaOnline || !models.length" value="">{{ ollamaOnline ? '无可用模型' : '正在发现模型…' }}</option>
                <option v-for="m in models" :key="m.name" :value="m.name">
                  {{ m.name }}{{ m.parameters ? ' · ' + m.parameters : '' }}
                </option>
              </select>
            </template>
            <template v-else>
              <label class="thinking-toggle" title="模型推理强度（像 OpenCode 一样多档；off 不思考）">
                <span>推理</span>
                <select class="model-select reasoning-select" v-model="reasoning"
                  :disabled="busy" aria-label="模型推理强度"
                  @change="onReasoningChange(reasoning)">
                  <option value="off">关</option>
                  <option value="low">低</option>
                  <option value="medium">中</option>
                  <option value="high">高</option>
                </select>
              </label>
              <button class="api-settings-toggle" type="button"
                :aria-expanded="apiSettingsOpen"
                @click="apiSettingsOpen = !apiSettingsOpen">
                {{ useHostConfig ? (hostApiModel || '站主 API') : (apiConfigured ? apiModel : '配置 API') }} <ArchiveIcon name="gear" />
              </button>
            </template>
          </div></details>
        </div>

        <FluidTransition>
<ChatApiSettings
          v-if="chatProvider === 'api' && apiSettingsOpen"
          :vendor="apiVendor"
          :base-url="useHostConfig ? (hostApiBaseUrl || apiBaseUrl) : apiBaseUrl"
          :model="useHostConfig ? (hostApiModel || apiModel) : apiModel"
          :api-key="useHostConfig ? '' : apiKey"
          :hint="apiConfigHint"
          :is-local-host="isLocalHost"
          :host-configured="hostApiConfigured"
          :host-model="hostApiModel"
          @update:vendor="apiVendor = $event"
          @update:base-url="apiBaseUrl = $event"
          @update:model="apiModel = $event"
          @update:api-key="apiKey = $event"
          @save="saveApiSettings"
          @save-host="saveToHost"
          @clear-host="clearHostConfigAndRefresh"
        />
</FluidTransition>

        <div v-if="(!chatReady || voiceCapabilityState === 'offline' || preparingRoom)
          && !(chatProvider === 'api' && !chatReady && apiSettingsOpen)" class="room-setup">
          <div>
            <strong>{{ setupTitle }}</strong>
            <span>{{ setupDescription }}</span>
          </div>
          <button v-if="chatProvider === 'local' || (chatReady && voiceCapabilityState === 'offline')"
            class="btn btn-primary" type="button" :disabled="preparingRoom" @click="prepareRoom">
            {{ preparingRoom ? '准备中…' : '准备聊天环境' }}
          </button>
          <button v-else class="btn btn-primary" type="button" @click="apiSettingsOpen = true">
            配置 API
          </button>
        </div>

        <div class="chat-list" ref="chatListRef" role="log" aria-label="对话记录">
          <div v-if="!currentMessages.length" class="chat-empty">
            <span class="chat-empty-kicker">{{ currentCharacter.roomCode }}</span>
            <div class="icon"><ArchiveIcon :name="currentCharacter.id === 'natsume' ? 'natsume' : 'nene'" /></div>
            <div class="chat-empty-greeting">{{ personalizedGreeting }}</div>
            <div class="chat-starters" aria-label="对话开场建议">
              <button v-for="s in currentCharacter.starters" :key="s" type="button"
                @click="useStarter(s)">{{ s }}</button>
            </div>
          </div>

          <template v-else>
            <div v-for="msg in currentMessages" :key="msg.mid"
              class="message"
              :class="[msg.role, msg.mid && msg.mid === streamingMid ? 'streaming' : '', msg.mid === playingMid ? 'speaking' : '']"
              :data-mid="msg.mid">
              <div class="message-avatar"><span v-if="msg.role === 'user'">你</span><ArchiveIcon v-else :name="currentCharacter.id === 'natsume' ? 'natsume' : 'nene'" /></div>
              <div class="message-body">
                <div class="message-bubble">
                  {{ msg.content }}
                  <div v-if="msg.role === 'assistant' && msg.recalledMemories?.length" class="msg-recalled-box">
                    <span class="msg-recalled-label" :title="msg.recalledMemories.map(m => '• ' + m).join('\n')">
                      <ArchiveIcon name="love" class="recalled-icon" /> 她记得 ({{ msg.recalledMemories.length }})
                    </span>
                  </div>
                </div>
                <div class="message-meta">
                  <span v-if="msg.stopped" class="message-note">已停止</span>
                  <button v-if="msg.role === 'user' && msg.mid" class="msg-memory-btn" type="button"
                    :class="{ remembered: messageRemembered(msg.mid) }"
                    :disabled="messageRemembered(msg.mid)" @click="rememberMessage(msg)">
                    <ArchiveIcon :name="messageRemembered(msg.mid) ? 'success' : 'pin'" />
                    <span>{{ messageRemembered(msg.mid) ? '已记住' : '钉住记忆' }}</span>
                  </button>
                  <button v-if="msg.role === 'assistant' && msg.mid && voice.hasAudio(msg.mid)"
                    class="msg-voice-btn" type="button"
                    :class="{ playing: playingMid === msg.mid }"
                    :data-mid="msg.mid" :title="playingMid === msg.mid ? '正在播放中…' : '重播这条语音'"
                    @click="voice.playMessage(msg.mid)">
                    <span v-if="playingMid === msg.mid" class="audio-equalizer" aria-hidden="true">
                      <span class="eq-bar"></span>
                      <span class="eq-bar"></span>
                      <span class="eq-bar"></span>
                    </span>
                    <ArchiveIcon v-else name="sound" />
                    <span>{{ playingMid === msg.mid ? '播放中' : '重播' }}</span>
                  </button>
                </div>
              </div>
            </div>
          </template>
        </div>

        <div v-if="toolActivity" class="chat-tool-indicator" role="status">
          <ArchiveIcon name="gear" /> {{ toolActivity }}
        </div>

        <div v-if="thinkingActivity" class="chat-tool-indicator" role="status">
          <ArchiveIcon name="spark" /> 思考中…
        </div>

        <FluidTransition>
<SpeechInputSettings v-if="speechSettingsOpen" class="speech-settings-host"
          @save="onSpeechSettingsSaved" @close="speechSettingsOpen = false" />
</FluidTransition>

        <div class="chat-composer">
          <div class="composer-row">
            <textarea class="chat-input" v-model="inputText" rows="2" maxlength="1200"
              placeholder="轻声对她说点什么吧……" aria-label="聊天输入"
              @keydown.enter.exact="submitChatOnEnter($event, handleSend)"
              @input="onInputChange"></textarea>
            <button class="btn btn-ghost stop-btn" type="button"
              v-show="busy || voiceActive"
              :title="busy ? '停止生成回复' : '停止语音播放'"
              @click="stopEverything">停止</button>
            <button class="btn btn-primary send-btn" type="button"
              :disabled="busy || !chatReady || !inputText.trim()"
              :title="chatReady ? '发送 (Enter 发送，Shift+Enter 换行)' : (chatProvider === 'api' ? '请先配置 API' : '请先启动 Ollama')"
              @click="handleSend">
              <span>{{ busy ? '回复中…' : '发送' }}</span>
              <kbd class="kbd-send-hint">↵</kbd>
            </button>
          </div>

          <div class="composer-tools">
            <div class="voice-console" aria-label="角色声线控制">
              <label v-if="chatProvider === 'api'" class="voice-toggle">
                <input type="checkbox" v-model="webSearchEnabled" />
                <span class="voice-switch" aria-hidden="true"><span></span></span>
                <span class="voice-toggle-copy"><strong>联网检索</strong><small>补充最新信息</small></span>
              </label>
              <span v-if="chatProvider === 'api'" class="voice-divider" aria-hidden="true"></span>
              <label class="voice-toggle">
                <input type="checkbox" v-model="autoVoice" @change="onAutoVoiceChange" />
                <span class="voice-switch" aria-hidden="true"><span></span></span>
                <span class="voice-toggle-copy"><strong>实时配音</strong><small>随回复逐句播放</small></span>
              </label>
              <span class="voice-divider" aria-hidden="true"></span>
              <span class="voice-capability" :data-state="voiceCapabilityState">
                <span class="voice-capability-dot"></span>{{ voiceCapabilityText }}
              </span>
              <span class="voice-status" aria-live="polite">{{ voiceStatusText }}</span>
              <RouterLink v-show="showVoiceRecovery" class="voice-recovery" to="/control">启动语音 →</RouterLink>
              <label class="volume-slider" title="音量">
                <span class="volume-icon" aria-hidden="true"><ArchiveIcon name="sound" /></span>
                <input type="range" v-model.number="volume" min="0" max="100" aria-label="音量"
                  @input="onVolumeChange" />
              </label>
              <button class="replay-btn" type="button" title="重新播放上一条语音"
                :disabled="!hasReplayable"
                @click="replayLast">
                <span aria-hidden="true">↩</span> 重播上一条
              </button>
            </div>
            <template v-if="speechReady">
              <span class="voice-divider" aria-hidden="true"></span>
              <button class="hold-talk-btn" type="button"
                :data-state="speechState"
                :disabled="speechState === 'recognizing'"
                :title="speechError || '按住说话，松开识别；也可按住空格或 Enter'"
                @keydown.space.prevent="onSpeechKeyPress"
                @keydown.enter.prevent="onSpeechKeyPress"
                @keyup.space.prevent="onSpeechRelease"
                @keyup.enter.prevent="onSpeechRelease"
                @blur="onSpeechCancel"
                @pointerdown.prevent="onSpeechPress"
                @pointerup="onSpeechRelease"
                @pointercancel="onSpeechCancel"
                @pointerleave="onSpeechLeave">
                <ArchiveIcon name="sound" /> {{ speechButtonText }}
              </button>
              <span class="voice-status speech-state-text" aria-live="polite">{{ speechStateText }}</span>
              <span v-if="speechSessionActive" class="speech-session-badge" role="status">
                <span class="speech-session-dot" aria-hidden="true"></span>连续对话中
                <button class="speech-session-end" type="button" title="结束连续对话" aria-label="结束连续对话"
                  @click="onSpeechSessionEnd">×</button>
              </span>
              <span v-else-if="speechAutoListening" class="speech-session-badge speech-session-badge-muted" role="status">
                <span class="speech-session-dot" aria-hidden="true"></span>听候唤醒
              </span>
              <span v-if="speechNotice" class="speech-notice" role="status">{{ speechNotice }}</span>
            </template>
            <button class="speech-config-btn" type="button" title="语音输入设置" aria-label="语音输入设置"
              :aria-expanded="speechSettingsOpen"
              @click="speechSettingsOpen = !speechSettingsOpen">
              语音输入设置
            </button>
            <span class="keyboard-hint">Enter 发送 · Shift+Enter 换行</span>
          </div>

          <div class="chat-error" role="status" aria-live="polite"
            :data-kind="chatErrorKind">{{ chatError }}</div>
          <p class="sr-only" role="status" aria-live="polite">{{ replyAnnouncement }}</p>
        </div>
      </section>
    </section>
  </article>
</template>

<script setup lang="ts">
import FluidTransition from "@/components/visual/FluidTransition.vue"
import '@/assets/css/chat.css'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useCharacterRoomSession } from '@/composables/chat/useCharacterRoomSession'
import ChatApiSettings from '@/components/ChatApiSettings.vue'
import ChatCharacterStage from '@/components/ChatCharacterStage.vue'
import ChatArchivePanel from '@/components/ChatArchivePanel.vue'
import ChatUserProfilePanel from '@/components/ChatUserProfilePanel.vue'
import ChatMemoryPanel from '@/components/ChatMemoryPanel.vue'
import SpeechInputSettings from '@/components/SpeechInputSettings.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { useVoiceInput, type VoiceTextSource, type VoiceInputState } from '@/composables/useVoiceInput'
import { isSpeechInputReady, loadSpeechInputConfig } from '@/utils/speechInputConfig'
import { createSpeechSession } from '@/utils/speechSession'
import type { ChatUserProfile } from '@/utils/chatUserProfile'
import { submitChatOnEnter } from '@/utils/chatInput'

const {
  chatListRef,
  characterStageRef,
  activeChar,
  busy,
  voiceActive,
  chatError,
  chatErrorKind,
  voiceStatusText,
  voiceCapabilityState,
  voiceCapabilityText,
  showVoiceRecovery,
  playingMid,
  isSpeaking,
  autoVoice,
  volume,
  preparingRoom,
  archiveOpen,
  storage,
  ollamaOnline,
  models,
  currentModel,
  chatProvider,
  apiBaseUrl,
  apiModel,
  apiKey,
  apiVendor,
  apiSettingsOpen,
  apiConfigHint,
  chatStatusText,
  statusKind,
  hostApiConfigured,
  hostApiModel,
  hostApiBaseUrl,
  useHostConfig,
  apiConfigured,
  chatReady,
  isLocalHost,
  currentCharacter,
  currentMessages,
  toolActivity,
  thinkingActivity,
  reasoning,
  userProfile,
  updateUserProfile,
  currentMemories,
  rememberMessage,
  updateMemory,
  deleteMemory,
  messageRemembered,
  onReasoningChange,
  webSearchEnabled,
  setupTitle,
  setupDescription,
  hasReplayable,
  inputText,
  streamingMid,
  replyAnnouncement,
  voice,
  setError,
  saveToHost,
  clearHostConfigAndRefresh,
  setChatProvider,
  saveApiSettings,
  onVolumeChange,
  handleSend,
  useStarter,
  onInputChange,
  prepareRoom,
  stopEverything,
  switchCharacter,
  clearCharacterConversation,
  clearAllMemory,
  onAutoVoiceChange,
  replayLast,
} = useCharacterRoomSession()

const profileOpen = ref(false)
const memoryOpen = ref(false)

/** 右上角次要操作收进「更多」菜单：外点与 Escape 关闭，选中即收起。 */
const moreOpen = ref(false)
const actionsMoreRef = ref<HTMLElement | null>(null)
function runRoomAction(action: () => void) {
  moreOpen.value = false
  actionsMoreRef.value?.querySelector<HTMLButtonElement>('.chat-more-trigger')?.focus()
  action()
}
function onRoomActionPointerDown(event: PointerEvent) {
  if (actionsMoreRef.value && event.target instanceof Node && !actionsMoreRef.value.contains(event.target)) {
    moreOpen.value = false
  }
}
function onRoomActionKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !moreOpen.value) return
  event.preventDefault()
  moreOpen.value = false
  actionsMoreRef.value?.querySelector<HTMLButtonElement>('.chat-more-trigger')?.focus()
}
function onRoomActionFocusout(event: FocusEvent) {
  if (event.relatedTarget instanceof Node && !actionsMoreRef.value?.contains(event.relatedTarget)) moreOpen.value = false
}
async function focusRoomAction(index: number) {
  moreOpen.value = true
  await nextTick()
  const items = actionsMoreRef.value?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
  if (items?.length) items[(index + items.length) % items.length]?.focus()
}
function navigateRoomActions(event: KeyboardEvent) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const items = [...(actionsMoreRef.value?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') || [])]
  const index = items.indexOf(document.activeElement as HTMLButtonElement)
  void focusRoomAction(event.key === 'Home' ? 0 : event.key === 'End' ? -1 : index + (event.key === 'ArrowDown' ? 1 : -1))
}
watch(moreOpen, open => {
  if (open) {
    document.addEventListener('pointerdown', onRoomActionPointerDown, true)
    document.addEventListener('keydown', onRoomActionKeydown)
  } else {
    document.removeEventListener('pointerdown', onRoomActionPointerDown, true)
    document.removeEventListener('keydown', onRoomActionKeydown)
  }
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onRoomActionPointerDown, true)
  document.removeEventListener('keydown', onRoomActionKeydown)
})

const personalizedGreeting = computed(() => {
  const char = currentCharacter.value
  const base = char.greeting
  const name = userProfile.value?.callName?.trim()
  if (!name) return base
  if (char.id === 'natsume') {
    return `${name}，你来了。${base}`
  }
  return `${name}，欢迎回来～ ${base}`
})

function onUserProfileSave(profile: ChatUserProfile) {
  updateUserProfile(profile)
  profileOpen.value = false
}

const speechConfig = ref(loadSpeechInputConfig())
const speechSettingsOpen = ref(false)
const speechSession = createSpeechSession()
const speechSessionState = ref(speechSession.state())
const stopSpeechSessionWatch = speechSession.onChange(() => { speechSessionState.value = speechSession.state() })
const speechNotice = ref('')
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

function applySpeechSession(): void {
  speechSession.applyConfig(speechConfig.value, currentCharacter.value.name)
}

applySpeechSession()

const speechReady = computed(() => isSpeechInputReady(speechConfig.value) && speechSupported)
const speechBusy = computed(() => speechState.value === 'capturing' || speechState.value === 'acquiring' || speechState.value === 'recognizing')

const speechButtonText = computed(() => {
  switch (speechState.value) {
    case 'acquiring': return '启动中…'
    case 'capturing': return '松开结束'
    case 'recognizing': return '识别中…'
    case 'error': return '重试'
    default: return '按住说话'
  }
})

const speechStateText = computed(() => {
  switch (speechState.value) {
    case 'capturing': return '聆听中…'
    case 'recognizing': return '正在识别…'
    case 'error': return speechError.value
    default: return ''
  }
})

const speechSessionActive = computed(() => {
  void speechSessionState.value
  return speechSession.isSessionActive()
})

function commitSpeechText(text: string): void {
  inputText.value = text
  if (speechConfig.value.autoSend && chatReady.value && !busy.value) handleSend()
}

function onSpeechText(text: string, source: VoiceTextSource): void {
  // 自动监听：未进会话时先做唤醒词匹配；未命中不打扰。
  if (source === 'auto' && !speechSession.isSessionActive()) {
    if (speechSession.onWakeText(text)) {
      speechNotice.value = `已唤醒${currentCharacter.value.name}，可以直接对话了`
      return
    }
    return
  }
  const action = speechSession.onSessionText(text)
  if (action === 'end') {
    speechNotice.value = '已退出连续对话'
    return
  }
  if (action === 'submit') {
    speechNotice.value = ''
    commitSpeechText(text)
  }
}

/** 会话状态/配置/忙闲变化时对齐自动监听（唤醒词连续对话）。 */
function reconcileAutoListen(): void {
  const shouldListen = speechReady.value
    && speechConfig.value.wakeEnabled
    && !busy.value
    && speechState.value !== 'error' // 权限被拒后不自动重试，等用户手动
    && speechSession.shouldAutoListen()
  if (shouldListen && !speechAutoListening.value) {
    void speechStart('auto')
  } else if (!shouldListen && speechAutoListening.value) {
    speechStop()
  }
}

watch(busy, value => {
  if (value) {
    speechSession.markReplyBusy()
  } else {
    speechSession.markReplyIdle()
  }
  reconcileAutoListen()
}, { immediate: true })

watch([speechState, speechConfig], () => {
  reconcileAutoListen()
})

watch(currentCharacter, () => {
  manualSpeechHeld = false
  speechCancel()
  speechNotice.value = ''
  applySpeechSession()
  reconcileAutoListen()
})

let manualSpeechHeld = false
function onSpeechPress(): void {
  if (speechBusy.value) return
  manualSpeechHeld = true
  void speechStart('manual')
}

function onSpeechKeyPress(event: KeyboardEvent): void {
  if (!event.repeat) onSpeechPress()
}

function onSpeechRelease(): void {
  if (!manualSpeechHeld) return
  manualSpeechHeld = false
  if (speechState.value === 'acquiring') speechCancel()
  else speechStop()
}

function onSpeechCancel(): void {
  if (!manualSpeechHeld) return
  manualSpeechHeld = false
  speechCancel()
}

function onSpeechLeave(event: PointerEvent): void {
  if (event.buttons > 0) onSpeechCancel()
}

function onSpeechSettingsSaved(): void {
  speechConfig.value = loadSpeechInputConfig()
  applySpeechSession()
  reconcileAutoListen()
  speechSettingsOpen.value = false
}

function onSpeechSessionEnd(): void {
  speechSession.endSession()
  speechNotice.value = '已结束连续对话'
  reconcileAutoListen()
}

onBeforeUnmount(() => {
  stopSpeechSessionWatch()
  speechRelease()
})
</script>
