<template>
  <article class="chat-page room-surface" :class="{ 'room-immersive': immersive }" :data-character="activeChar">
    <h1 class="sr-only">角色聊天</h1>
    <Teleport to="body">
      <dialog ref="roomPanelDialog" class="room-tools-dialog" :aria-label="roomPanel ? roomPanelLabels[roomPanel] : undefined"
        @cancel.prevent="closeRoomPanel" @close="onRoomPanelClosed" @click="closeRoomPanelFromBackdrop">
        <!-- Keep conditional content separate from Reka's sibling portal anchors. -->
        <div class="room-panel-content">
        <ChatArchivePanel v-if="roomPanel === 'archive'" :storage="storage" :active-char="activeChar"
          @vue:mounted="focusRoomPanel" @close="closeRoomPanel" @notice="(message, kind) => setError(message, kind || 'info', 4500)" />
        <ChatUserProfilePanel v-else-if="roomPanel === 'profile'" :key="roomPanelGeneration" :profile="userProfile" :save-profile="onUserProfileSave"
          @vue:mounted="focusRoomPanel" @close="closeRoomPanel" />
        <ChatMemoryPanel v-else-if="roomPanel === 'memory'" :items="currentMemories" :character-name="currentCharacter.name"
          @vue:mounted="focusRoomPanel" @update="updateMemory" @delete="deleteMemory" @close="closeRoomPanel" />
        <section v-else-if="roomPanel === 'settings'" class="room-chat-settings chat-page">
          <header><strong>聊天设置</strong><button class="btn btn-ghost" type="button" aria-label="关闭聊天设置" @click="closeRoomPanel"><ArchiveIcon name="close" /></button></header>
          <ChatModelControls :chat-provider="chatProvider" :busy="busy"
            :ollama-online="ollamaOnline" :local-status-text="localStatusText" :checking-local="checkingChatStatus"
            :models="models" :current-model="currentModel" :reasoning="reasoning" :companion-tools="companionTools" :web-search-enabled="webSearchEnabled"
            :api-settings-open="apiSettingsOpen" :use-host-config="useHostConfig" :host-api-model="hostApiModel" :host-api-base-url="hostApiBaseUrl"
            :api-configured="apiConfigured" :api-model="apiModel" :api-base-url="apiBaseUrl"
            @set-provider="setChatProvider" @refresh-local="refreshChatStatus"
            @update:current-model="currentModel = $event" @reasoning-change="onReasoningChange" @update:companion-tools="companionTools = $event" @toggle-api-settings="apiSettingsOpen = !apiSettingsOpen" />
          <ChatApiSettings v-if="chatProvider === 'api' && apiSettingsOpen"
            :vendor="apiVendor" :base-url="apiBaseUrl" :model="apiModel" :api-key="apiKey"
            :credentials-loading="storage.credentialsLoading.value" :busy="busy" :hint="apiConfigHint"
            :is-local-host="isLocalHost" :host-configured="hostApiConfigured" :host-model="hostApiModel"
            @update:vendor="apiVendor = $event" @update:base-url="apiBaseUrl = $event" @update:model="apiModel = $event" @update:api-key="apiKey = $event"
            @save="saveApiSettings" @clear-key="clearApiCredential" @save-host="saveToHost" @clear-host="clearHostConfigAndRefresh" />
          <div class="room-settings-options">
            <ToggleSwitch v-if="chatProvider === 'api' && isLocalHost" v-model="webSearchEnabled" label="联网检索">联网检索</ToggleSwitch>
            <ToggleSwitch v-if="currentCharacter.voice" :model-value="autoVoice" label="自动播放语音" @update:model-value="autoVoice = $event; onAutoVoiceChange()">自动播放语音</ToggleSwitch>
            <label v-if="currentCharacter.voice" class="room-volume"><span>音量 <small>{{ volume }}%</small></span><input type="range" v-model.number="volume" min="0" max="100" aria-label="播放音量" @input="onVolumeChange" /></label>
          </div>
          <div class="room-settings-voice">
            <span>{{ voiceCapabilityText }}</span><RouterLink v-if="showVoiceRecovery" class="btn btn-ghost btn-sm" to="/control" @click="closeRoomPanel">启动语音<ArchiveIcon name="chevron-down" /></RouterLink>
            <StudioPopover v-model:open="speechSettingsOpen" label="语音输入设置" content-class="chat-speech-settings" @open-auto-focus="focusSpeechPopover">
              <template #trigger><button class="btn btn-ghost" type="button">语音输入设置</button></template>
              <Suspense v-if="speechSettingsOpen">
                <SpeechInputSettings :data-character="activeChar" @vue:mounted="focusSpeechSettings" @save="onSpeechSettingsSaved" @close="speechSettingsOpen = false" />
                <template #fallback><p role="status" class="tw:m-0 tw:p-s-4">正在加载…</p></template>
              </Suspense>
            </StudioPopover>
          </div>
        </section>
        </div>
      </dialog>
    </Teleport>
    <section class="chat-layout" aria-label="角色聊天">
      <ChatCharacterStage ref="characterStageRef" :active-id="activeChar" :suspended="presentationSuspended"
        :surface="immersive ? 'immersive' : 'room'" :character="currentCharacter" :speaking="isSpeaking"
        :volume="volume" :chat-status-text="chatStatusText" :status-kind="statusKind"
        :auto-load="storage.state.settings.live2dEnabled" :outfit="storage.live2dOutfit(activeChar)"
        @select="switchCharacter" @live2d-enabled="storage.setLive2dEnabled" @outfit-changed="storage.setLive2dOutfit(activeChar, $event)" />
      <section class="conversation-card" data-route-arrive v-content-motion:up="activeChar" :aria-label="immersive ? '当前对话' : '完整对话'">
        <header class="conversation-head">
          <div class="room-chat-identity">
            <RuntimeImage class="room-chat-avatar" :src="avatar" alt="" :data-chibi="Boolean(companionChatAvatars[activeChar]) || undefined" />
            <CompanionCharacterPicker :model-value="activeChar" @update:model-value="switchCharacter" />
          </div>
          <div class="room-chat-actions">
            <StudioTooltip :content="immersive ? '展开对话' : '专注陪伴'"><button class="btn btn-ghost" type="button" :aria-label="immersive ? '展开对话' : '专注陪伴'" :aria-pressed="immersive" @click="toggleImmersive"><ArchiveIcon :name="immersive ? 'chat' : 'moon'" /></button></StudioTooltip>
            <StudioTooltip content="新对话"><button class="btn btn-ghost" type="button" aria-label="新对话" @click="clearCharacterConversation"><ArchiveIcon name="broom" /></button></StudioTooltip>
            <StudioTooltip content="聊天设置"><button class="btn btn-ghost chat-settings-trigger" type="button" aria-label="聊天设置" @click="openRoomPanel('settings')"><ArchiveIcon name="gear" /></button></StudioTooltip>
            <ChatActionsMenu @clear-all="clearAllMemory" @toggle-archive="openRoomPanel('archive')" @toggle-memory="openRoomPanel('memory')" @toggle-profile="openRoomPanel('profile')" />
          </div>
        </header>
        <div v-if="!chatReady || preparingRoom" class="room-setup">
          <strong>{{ setupTitle }}</strong>
          <button v-if="chatProvider === 'local'" class="btn btn-primary btn-sm" type="button" :disabled="preparingRoom" @click="prepareRoom">{{ preparingRoom ? '准备中…' : '连接模型' }}</button>
          <button v-else class="btn btn-primary btn-sm" type="button" @click="apiSettingsOpen = true; openRoomPanel('settings')">选择模型</button>
        </div>
        <div v-show="!immersive" class="chat-list" ref="chatListRef" role="log" aria-live="off" aria-label="对话记录">
          <div v-if="!currentMessages.length" class="chat-empty">
            <RuntimeImage class="room-empty-avatar" :src="avatar" alt="" />
            <div class="chat-empty-greeting">{{ personalizedGreeting }}</div>
            <div class="chat-starters" aria-label="对话开场建议"><button v-for="s in currentCharacter.starters" :key="s" type="button" @click="useStarter(s)">{{ s }}</button></div>
          </div>
          <div v-for="msg in currentMessages" :key="msg.mid" class="message"
            :class="[msg.role, { streaming: msg.mid === streamingMid, speaking: msg.mid === playingMid }]" :data-mid="msg.mid">
            <div v-if="msg.role === 'assistant'" class="message-avatar" :data-chibi="Boolean(companionChatAvatars[activeChar]) || undefined" aria-hidden="true">
              <RuntimeImage :src="avatar" alt=""><template #fallback><ArchiveIcon name="character" /></template></RuntimeImage>
            </div>
            <div class="message-body">
              <div class="message-bubble">
                <ChatMessageText v-if="msg.content" :text="msg.content" />
                <CompanionChatImages v-if="msg.images?.length" :images="msg.images" />
                <CompanionDrawingDraftCard v-for="drawing in msg.drawingDrafts || []" :key="drawing.path" :draft="drawing" />
                <span v-if="!msg.content && msg.mid === streamingMid" class="room-message-waiting">正在回复…</span>
              </div>
              <span v-if="msg.stopped || msg.mid === playingMid" class="message-note">{{ msg.stopped ? '已停止' : '播放中' }}</span>
            </div>
            <ChatMessageActions :can-copy="Boolean(msg.content)" :can-remember="msg.role === 'user' && Boolean(msg.mid)"
              :remembered="Boolean(msg.mid && messageRemembered(msg.mid))" :can-play="msg.role === 'assistant' && Boolean(msg.mid && voice.hasAudio(msg.mid))"
              :playing="msg.mid === playingMid" :memories="msg.recalledMemories"
              @copy="copyMessage(msg.content)" @remember="rememberMessage(msg)" @play="msg.mid && voice.playMessage(msg.mid)" />
          </div>
        </div>
        <button v-if="!immersive && hasNew" class="room-latest btn btn-ghost" type="button" @click="latest">回到最新消息</button>
        <div v-if="immersive" class="room-current-line" role="log" aria-live="off" aria-label="最近一句回复"><p>{{ currentLine }}</p></div>
        <div v-if="activityText" class="room-chat-activity" role="status"><span>{{ activityText }}</span><button v-if="speechSessionActive" class="btn btn-ghost btn-sm" type="button" aria-label="结束连续对话" @click="onSpeechSessionEnd"><ArchiveIcon name="close" /></button></div>
        <div class="chat-composer">
          <div class="composer-row">
            <StudioTooltip v-if="speechReady" anchor :content="speechError || (busy || voiceActive ? '请等待当前回复或语音结束' : speechButtonText)">
              <button class="hold-talk-btn" type="button" :aria-label="speechButtonText" :data-state="speechState" :disabled="speechButtonDisabled"
                @keydown.space.prevent="onSpeechKeyPress" @keydown.enter.prevent="onSpeechKeyPress" @keyup.space.prevent="onSpeechRelease" @keyup.enter.prevent="onSpeechRelease"
                @blur="onSpeechCancel" @pointerdown.prevent="onSpeechPress" @pointerup="onSpeechRelease" @pointercancel="onSpeechCancel" @pointerleave="onSpeechLeave"><ArchiveIcon name="sound" /></button>
            </StudioTooltip>
            <textarea ref="inputRef" class="chat-input" v-model="inputText" rows="1" maxlength="1200" placeholder="发消息…" aria-label="聊天输入"
              @keydown.enter.exact="submitChatOnEnter($event, handleSend)" @input="onComposerInput"></textarea>
            <StudioTooltip v-if="busy || voiceActive" content="停止回复或语音"><button class="btn btn-ghost stop-btn" type="button" aria-label="停止回复或语音" @click="stopEverything"><ArchiveIcon name="stop" /></button></StudioTooltip>
            <StudioTooltip v-else anchor :content="chatReady ? '发送 · Enter（Shift+Enter 换行）' : '请先连接聊天模型'"><button class="btn btn-primary send-btn" type="button" aria-label="发送"
              :disabled="!chatReady || !inputText.trim() || storage.writeBlocked.value" @click="handleSend"><ArchiveIcon name="send" /></button></StudioTooltip>
          </div>
          <div v-if="storage.writeBlocked.value || chatError" class="chat-error" role="status" aria-live="polite" :data-kind="storage.writeBlocked.value ? 'warning' : chatErrorKind">{{ storage.writeBlocked.value ? '聊天数据暂时不可写入，请升级或恢复兼容数据。' : chatError }}</div>
          <p class="sr-only" role="status" aria-live="polite">{{ !busy ? replyAnnouncement : '' }}</p>
        </div>
      </section>
    </section>
  </article>
</template>

<script setup lang="ts">
import ToggleSwitch from '@/components/visual/ToggleSwitch.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import StudioPopover from '@/components/ui/StudioPopover.vue'
import '@/assets/css/chat.css'
import '@/assets/css/conversation-room.css'
import { useConversationReading } from '@/composables/chat/useConversationReading'
import { isBackdropClick, useFluidDialog } from '@/composables/useFluidDialog'
import { useRoomPresentation } from '@/composables/chat/useRoomPresentation'
import { computed, defineAsyncComponent, nextTick, ref, watch } from 'vue'
import { useCharacterRoomSession } from '@/composables/chat/useCharacterRoomSession'
import ChatMessageText from '@/components/ChatMessageText.vue'
import ChatMessageActions from '@/components/ChatMessageActions.vue'
import RuntimeImage from '@/components/visual/RuntimeImage.vue'
import { companionChatAvatars } from '@/config/companionChatAvatars'
import { characterArtEntry } from '@/platform/characterArtState'
import { resolveCompanionAvatar } from '@/utils/companionRegistry'
import ChatCharacterStage from '@/components/ChatCharacterStage.vue'
import ChatActionsMenu from '@/components/ChatActionsMenu.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { useChatSpeechInteraction } from '@/composables/chat/useChatSpeechInteraction'
import type { ChatUserProfile } from '@/utils/chatUserProfile'
import { submitChatOnEnter } from '@/utils/chatInput'

const CompanionCharacterPicker = defineAsyncComponent(() => import('@/components/CompanionCharacterPicker.vue'))
// Model controls and their select/disclosure dependencies are only needed in settings.
const ChatModelControls = defineAsyncComponent(() => import('@/components/ChatModelControls.vue'))
const ChatApiSettings = defineAsyncComponent(() => import('@/components/ChatApiSettings.vue'))
const SpeechInputSettings = defineAsyncComponent(() => import('@/components/SpeechInputSettings.vue'))
const CompanionDrawingDraftCard = defineAsyncComponent(() => import('@/components/CompanionDrawingDraftCard.vue'))
const CompanionChatImages = defineAsyncComponent(() => import('@/components/CompanionChatImages.vue'))
// These panels mount only after a menu action; load their component CSS then too.
const ChatArchivePanel = defineAsyncComponent(() => import('@/components/ChatArchivePanel.vue'))
const ChatUserProfilePanel = defineAsyncComponent(() => import('@/components/ChatUserProfilePanel.vue'))
const ChatMemoryPanel = defineAsyncComponent(() => import('@/components/ChatMemoryPanel.vue'))

const {
  chatListRef,
  characterStageRef,
  activeChar,
  busy,
  voiceActive,
  chatError,
  chatErrorKind,
  voiceCapabilityState,
  voiceCapabilityText,
  showVoiceRecovery,
  playingMid,
  isSpeaking,
  autoVoice,
  volume,
  preparingRoom,
  storage,
  ollamaOnline, localStatusText, checkingChatStatus, refreshChatStatus,
  models,
  currentModel,
  chatProvider,
  apiBaseUrl,
  hostApiBaseUrl,
  apiModel,
  apiKey,
  apiVendor,
  apiSettingsOpen,
  apiConfigHint,
  chatStatusText,
  statusKind,
  hostApiConfigured,
  hostApiModel,
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
  webSearchEnabled, companionTools,
  setupTitle,
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
} = useCharacterRoomSession()

type RoomPanel = 'archive' | 'memory' | 'profile' | 'settings'
const roomPanel = ref<RoomPanel | null>(null)
const roomPanelGeneration = ref(0)
let roomPanelClosing = false
const roomPanelLabels = { archive: '对话归档', memory: '长期记忆', profile: '我的档案', settings: '聊天设置' }
const roomPanelDialog = ref<HTMLDialogElement | null>(null)
const roomPanelMotion = useFluidDialog(roomPanelDialog)
async function openRoomPanel(panel: RoomPanel) {
  roomPanelClosing = false
  roomPanelGeneration.value++
  roomPanel.value = panel
  await nextTick()
  roomPanelMotion.open(document.querySelector<HTMLElement>(panel === 'settings' ? '.chat-settings-trigger' : '.chat-more-trigger'))
  focusRoomPanel()
}
function focusRoomPanel() {
  if (roomPanelDialog.value?.open) roomPanelDialog.value.querySelector<HTMLElement>('button')?.focus({ preventScroll: true })
}
function clearRoomPanel() { roomPanel.value = null; apiSettingsOpen.value = false; speechSettingsOpen.value = false }
function closeRoomPanel() { roomPanelClosing = true; speechSettingsOpen.value = false; roomPanelMotion.close(clearRoomPanel) }
function onRoomPanelClosed() { if (!roomPanelDialog.value?.open) clearRoomPanel() }
function closeRoomPanelFromBackdrop(event: MouseEvent) {
  if (isBackdropClick(event, roomPanelDialog.value)) closeRoomPanel()
}
const immersive = ref(false)
const presentationSuspended = useRoomPresentation('room')
const { hasNew, latest } = useConversationReading(chatListRef, () => currentMessages.value, activeChar)
const currentLine = computed(() => [...currentMessages.value].reverse().find(m => m.role === 'assistant')?.content || personalizedGreeting.value)
function toggleImmersive() { immersive.value = !immersive.value; if (!immersive.value) void latest() }
async function copyMessage(content: string) {
  try { await navigator.clipboard.writeText(content); setError('已复制', 'info', 1800) }
  catch { setError('复制失败，可以选中文字后复制。', 'warning') }
}

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

async function onUserProfileSave(profile: ChatUserProfile): Promise<boolean> {
  const generation = roomPanelGeneration.value
  return await updateUserProfile(profile) && generation === roomPanelGeneration.value && !roomPanelClosing && roomPanel.value === 'profile'
}

const {
  speechSettingsOpen,
  speechNotice,
  speechState,
  speechError,
  speechAutoListening,
  speechReady,
  speechButtonDisabled,
  speechButtonText,
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
  busy: computed(() => busy.value || voiceActive.value || roomPanel.value === 'settings'),
  inputText,
  handleSend,
})
watch([apiSettingsOpen, speechSettingsOpen], ([api, speech]) => {
  if ((api || speech) && !roomPanelClosing && roomPanel.value !== 'settings') void openRoomPanel('settings')
}, { immediate: true })
const avatar = computed(() => companionChatAvatars[activeChar.value] || characterArtEntry(activeChar.value)?.thumbnailUrl || resolveCompanionAvatar(activeChar.value)?.avatar.thumbnailUrl || currentCharacter.value.image)
const activityText = computed(() => toolActivity.value || (thinkingActivity.value ? '思考中…' : '')
  || (speechState.value === 'error' ? speechError.value : '')
  || (isSpeaking.value ? '正在说话' : '') || (busy.value ? '正在回复…' : '')
  || (['acquiring', 'capturing', 'recognizing'].includes(speechState.value) ? speechButtonText.value : '')
  || speechNotice.value || (speechSessionActive.value ? '连续对话中' : speechAutoListening.value ? '听候唤醒' : ''))
const inputRef = ref<HTMLTextAreaElement>()
function resizeInput() {
  if (!inputRef.value) return
  inputRef.value.style.height = 'auto'
  inputRef.value.style.height = `${Math.min(inputRef.value.scrollHeight, 120)}px`
}
function onComposerInput() { onInputChange(); resizeInput() }
watch(inputText, () => { void nextTick(resizeInput) })
async function focusSpeechPopover(event: Event) {
  event.preventDefault()
  const opener = document.activeElement
  await nextTick()
  const panel = document.querySelector<HTMLElement>('.chat-speech-settings')
  if (!speechSettingsOpen.value || !panel || (document.activeElement !== opener && !panel.contains(document.activeElement))) return
  ;(panel.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled)') || panel).focus({ preventScroll: true })
}
function focusSpeechSettings() {
  const panel = document.querySelector<HTMLElement>('.chat-speech-settings')
  // An uncached editor arrives after Reka focuses the empty popover. Preserve
  // any focus the user has moved elsewhere while it was loading.
  if (speechSettingsOpen.value && panel === document.activeElement)
    panel?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled)')?.focus({ preventScroll: true })
}
</script>
