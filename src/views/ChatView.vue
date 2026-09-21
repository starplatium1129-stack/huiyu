<template>
  <article class="chat-page room-surface" :class="{ 'room-immersive': immersive }" :data-character="activeChar">
    <header class="chat-head">
      <div>
        <div class="room-title-group"><span class="room-eyebrow">HUIYU / COMPANION ROOM</span><h1 class="room-title">此刻，与你</h1></div>
        <CompanionCharacterPicker :model-value="activeChar" @update:model-value="switchCharacter" />
      </div>
      <div class="chat-actions">
        <button class="btn btn-ghost" type="button" :aria-pressed="immersive" @click="toggleImmersive"><ArchiveIcon :name="immersive ? 'chat' : 'moon'" />{{ immersive ? '展开对话' : '专注陪伴' }}</button>
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
                @click="runRoomAction(() => clearAllMemory())">清空聊天内容与个人档案</button>
              <button class="chat-more-item" role="menuitem" type="button"
                @click="runRoomAction(() => { archiveOpen = !archiveOpen })">对话归档</button>
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
        :suspended="presentationSuspended"
        :surface="immersive ? 'immersive' : 'room'"
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

      <section class="conversation-card" :aria-label="immersive ? '当前对话' : '完整对话'">
        <div class="conversation-head">
          <div class="room-conversation-title"><strong>{{ immersive ? '此刻的话' : '我们的对话' }}</strong><span>{{ isSpeaking ? '正在说话' : busy ? '正在回复' : currentCharacter.voice ? '慢慢说，我在听' : '文字聊天' }}</span></div>
          <ChatModelControls
            :chat-provider="chatProvider"
            :busy="busy"
            :ollama-online="ollamaOnline"
            :models="models"
            :current-model="currentModel"
            :reasoning="reasoning"
            :api-settings-open="apiSettingsOpen"
            :use-host-config="useHostConfig"
            :host-api-model="hostApiModel"
            :api-configured="apiConfigured"
            :api-model="apiModel"
            @set-provider="setChatProvider"
            @update:current-model="currentModel = $event"
            @reasoning-change="onReasoningChange"
            @toggle-api-settings="apiSettingsOpen = !apiSettingsOpen"
          ><label v-if="currentCharacter.voice" class="room-volume">播放音量<input type="range" v-model.number="volume" min="0" max="100" aria-label="播放音量" @input="onVolumeChange" /></label></ChatModelControls>
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
          @clear-key="clearApiCredential"
          @save-host="saveToHost"
          @clear-host="clearHostConfigAndRefresh"
        />
</FluidTransition>

        <div v-if="(!chatReady || preparingRoom)
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

        <div v-show="!immersive" class="chat-list" ref="chatListRef" role="log" aria-label="对话记录">
          <div v-if="!currentMessages.length" class="chat-empty">
            <span class="chat-empty-kicker">{{ currentCharacter.name }}</span>
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
              <div class="message-avatar"><span v-if="msg.role === 'user'">你</span><ArchiveIcon v-else :name="activeChar === 'nene' ? 'nene' : activeChar === 'natsume' ? 'natsume' : 'character'" /></div>
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
                  <button class="msg-memory-btn" type="button" @click="copyMessage(msg.content)">复制</button>
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

        <button v-if="!immersive && hasNew" class="room-latest btn btn-ghost" type="button" @click="latest">回到最新消息</button>
        <div v-if="immersive" class="room-current-line" role="log" aria-label="最近一句回复"><p>{{ currentLine }}</p></div>

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
              :disabled="busy || !chatReady || !inputText.trim() || storage.writeBlocked.value"
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
              <label v-if="currentCharacter.voice" class="voice-toggle">
                <input type="checkbox" v-model="autoVoice" @change="onAutoVoiceChange" />
                <span class="voice-switch" aria-hidden="true"><span></span></span>
                <span class="voice-toggle-copy"><strong>实时配音</strong><small>随回复逐句播放</small></span>
              </label>
              <span v-if="currentCharacter.voice" class="voice-divider" aria-hidden="true"></span>
              <span class="voice-capability" :data-state="voiceCapabilityState">
                <span class="voice-capability-dot"></span>{{ voiceCapabilityText }}
              </span>
              <span class="voice-status" aria-live="polite">{{ voiceStatusText }}</span>
              <RouterLink v-show="showVoiceRecovery" class="voice-recovery" to="/control">启动语音 →</RouterLink>
              <label v-if="currentCharacter.voice" class="volume-slider" title="音量">
                <span class="volume-icon" aria-hidden="true"><ArchiveIcon name="sound" /></span>
                <input type="range" v-model.number="volume" min="0" max="100" aria-label="音量"
                  @input="onVolumeChange" />
              </label>
              <button v-if="currentCharacter.voice" class="replay-btn" type="button" title="重新播放上一条语音"
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
            :data-kind="storage.writeBlocked.value ? 'warning' : chatErrorKind">{{ storage.writeBlocked.value ? '聊天数据版本不兼容或已损坏，原件已保留；请升级或恢复兼容数据后再发送、清空或保存。' : chatError }}</div>
          <p class="sr-only" role="status" aria-live="polite">{{ replyAnnouncement }}</p>
        </div>
      </section>
    </section>
  </article>
</template>

<script setup lang="ts">
import FluidTransition from "@/components/visual/FluidTransition.vue"
import '@/assets/css/chat.css'
import '@/assets/css/conversation-room.css'
import CompanionCharacterPicker from '@/components/CompanionCharacterPicker.vue'
import { useConversationReading } from '@/composables/chat/useConversationReading'
import { useRoomPresentation } from '@/composables/chat/useRoomPresentation'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useCharacterRoomSession } from '@/composables/chat/useCharacterRoomSession'
import ChatApiSettings from '@/components/ChatApiSettings.vue'
import ChatModelControls from '@/components/ChatModelControls.vue'
import ChatCharacterStage from '@/components/ChatCharacterStage.vue'
import ChatArchivePanel from '@/components/ChatArchivePanel.vue'
import ChatUserProfilePanel from '@/components/ChatUserProfilePanel.vue'
import ChatMemoryPanel from '@/components/ChatMemoryPanel.vue'
import SpeechInputSettings from '@/components/SpeechInputSettings.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { useChatSpeechInteraction } from '@/composables/chat/useChatSpeechInteraction'
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
  clearApiCredential,
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
const immersive = ref(false)
const presentationSuspended = useRoomPresentation('room')
const { hasNew, latest } = useConversationReading(chatListRef, () => currentMessages.value, activeChar)
const currentLine = computed(() => [...currentMessages.value].reverse().find(m => m.role === 'assistant')?.content || personalizedGreeting.value)
function toggleImmersive() { immersive.value = !immersive.value; if (!immersive.value) void latest() }
async function copyMessage(content: string) {
  try { await navigator.clipboard.writeText(content); setError('已复制', 'info', 1800) }
  catch { setError('复制失败，可以选中文字后复制。', 'warning') }
}

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

const {
  speechConfig,
  speechSettingsOpen,
  speechNotice,
  speechState,
  speechError,
  speechAutoListening,
  speechReady,
  speechButtonText,
  speechStateText,
  speechSessionActive,
  onSpeechPress,
  onSpeechKeyPress,
  onSpeechRelease,
  onSpeechCancel,
  onSpeechLeave,
  onSpeechSettingsSaved,
  onSpeechSessionEnd,
} = useChatSpeechInteraction({
  currentCharacter,
  chatReady,
  busy,
  inputText,
  handleSend,
})
</script>
