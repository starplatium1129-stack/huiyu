<template>
  <article class="chat-page room-surface" :class="{ 'room-immersive': immersive }" :data-character="activeChar">
    <h1 class="sr-only">角色聊天</h1>
    <Teleport to="body">
      <dialog ref="roomPanelDialog" class="room-tools-dialog" :aria-label="roomPanel ? roomPanelLabels[roomPanel] : undefined"
        @cancel.prevent="closeRoomPanel" @close="onRoomPanelClosed" @click="closeRoomPanelFromBackdrop">
        <!-- Keep conditional content separate from Reka's sibling portal anchors. -->
        <div class="room-panel-content">
        <AsyncPanel v-if="roomPanel && roomPanel !== 'settings'" :key="roomPanelGeneration" :loader="roomToolLoaders[roomPanel]" :label="roomPanelLabels[roomPanel]">
          <template #default="{ component }">
            <component :is="component" v-if="roomPanel === 'archive'" :storage="storage" :active-char="activeChar"
              @vue:mounted="focusRoomPanel" @close="closeRoomPanel" @notice="(message: string, kind?: 'info' | 'warning' | 'error') => setError(message, kind || 'info', 4500)" />
            <component :is="component" v-else-if="roomPanel === 'profile'" :profile="userProfile" :save-profile="onUserProfileSave"
              @vue:mounted="focusRoomPanel" @close="closeRoomPanel" />
            <component :is="component" v-else-if="roomPanel === 'memory'" :items="currentMemories" :character-name="currentCharacter.name"
              @vue:mounted="focusRoomPanel" @update="updateMemory" @delete="deleteMemory" @close="closeRoomPanel" />
          </template>
          <template #feedback="{ failed, retried, retry, reload }">
            <section class="room-tool-panel room-panel-loading" aria-labelledby="roomPanelLoadingTitle">
              <header class="room-tool-heading"><div><span>CHAT TOOLS</span><h2 id="roomPanelLoadingTitle">{{ roomPanel ? roomPanelLabels[roomPanel] : '' }}</h2></div><button class="btn btn-quiet btn-icon" type="button" aria-label="关闭聊天工具" @click="closeRoomPanel"><ArchiveIcon name="close" /></button></header>
              <div class="room-tool-body">
                <p class="room-panel-loading-status" :role="failed ? 'alert' : 'status'"><ArchiveIcon name="chat" /><span>{{ failed ? (retried ? '聊天工具仍未加载，请检查连接后重新载入应用。' : '聊天工具暂未加载，请重新读取。') : '正在加载…' }}</span></p>
                <button v-if="failed" class="btn btn-ghost btn-sm tw:justify-self-center" type="button" @click="retried ? reload() : retry()">{{ retried ? '重新载入应用' : '重新读取' }}</button>
              </div>
            </section>
          </template>
        </AsyncPanel>
        <section v-else-if="roomPanel === 'settings'" class="room-chat-settings chat-page room-tool-panel" aria-labelledby="roomChatSettingsTitle">
          <header class="room-tool-heading"><div><span>CHAT SETTINGS</span><h2 id="roomChatSettingsTitle">聊天设置</h2></div><button class="btn btn-quiet btn-icon" type="button" aria-label="关闭聊天设置" @click="closeRoomPanel"><ArchiveIcon name="close" /></button></header>
          <div class="room-tool-body">
            <AsyncPanel :loader="loadChatModelControls" label="聊天模型设置" v-slot="{ component }"><component :is="component" :chat-provider="chatProvider" :busy="busy"
              :ollama-online="ollamaOnline" :local-status-text="localStatusText" :checking-local="checkingChatStatus"
              :models="models" :current-model="currentModel" :reasoning="reasoning" :companion-tools="companionTools" :web-search-enabled="webSearchEnabled"
              :api-settings-open="apiSettingsOpen" :use-host-config="useHostConfig" :host-api-model="hostApiModel" :host-api-base-url="hostApiBaseUrl"
              :api-configured="apiConfigured" :api-model="apiModel" :api-base-url="apiBaseUrl"
              @set-provider="setChatProvider" @refresh-local="refreshChatStatus"
              @update:current-model="currentModel = $event" @reasoning-change="onReasoningChange" @update:companion-tools="companionTools = $event" @toggle-api-settings="apiSettingsOpen = !apiSettingsOpen" /></AsyncPanel>
            <AsyncPanel v-if="chatProvider === 'api' && apiSettingsOpen" :loader="loadChatApiSettings" label="API 模型配置" v-slot="{ component }"><component :is="component"
              :vendor="apiVendor" :base-url="apiBaseUrl" :model="apiModel" :api-key="apiKey"
              :credentials-loading="storage.credentialsLoading.value" :busy="busy" :hint="apiConfigHint"
              :is-local-host="isLocalHost" :host-configured="hostApiConfigured" :host-model="hostApiModel"
              @update:vendor="apiVendor = $event" @update:base-url="apiBaseUrl = $event" @update:model="apiModel = $event" @update:api-key="apiKey = $event"
              @save="saveApiSettings" @clear-key="clearApiCredential" @save-host="saveToHost" @clear-host="clearHostConfigAndRefresh" /></AsyncPanel>
            <div class="room-settings-options">
              <ToggleSwitch v-if="chatProvider === 'api' && isLocalHost" v-model="webSearchEnabled" label="联网检索">联网检索</ToggleSwitch>
              <ToggleSwitch v-if="currentCharacter.voice" :model-value="autoVoice" label="自动播放语音" @update:model-value="autoVoice = $event; onAutoVoiceChange()">自动播放语音</ToggleSwitch>
              <label v-if="currentCharacter.voice" class="room-volume"><span>音量 <small>{{ volume }}%</small></span><input type="range" v-model.number="volume" min="0" max="100" aria-label="播放音量" @input="onVolumeChange" /></label>
            </div>
            <AsyncPanel v-if="chatProvider === 'api' && isLocalHost" :loader="loadChatSearchSettings" label="搜索设置" v-slot="{ component }"><component :is="component"
              :api-base-url="apiBaseUrl" :api-key="apiKey" :use-host-config="useHostConfig" :host-api-base-url="hostApiBaseUrl" :busy="busy" /></AsyncPanel>
            <div class="room-settings-voice">
              <span>{{ voiceCapabilityText }}</span><RouterLink v-if="showVoiceRecovery" class="btn btn-ghost btn-sm" to="/control" @click="closeRoomPanel">启动语音<ArchiveIcon name="chevron-down" /></RouterLink>
              <AsyncPanel class="room-speech-popover-loader" :loader="loadSpeechPopover" label="语音输入设置" v-slot="{ component: popoverComponent }">
              <component :is="popoverComponent" v-model:open="speechSettingsOpen" label="语音输入设置" side="top" prioritize-position content-class="chat-speech-settings speech-settings-popover" @open-auto-focus="focusSpeechPopover" @close-auto-focus="returnSpeechFocus">
                <template #trigger><button class="btn btn-ghost" type="button">语音输入设置</button></template>
                <AsyncPanel v-if="speechSettingsOpen" :loader="loadSpeechInputSettings" label="语音输入设置" v-slot="{ component }"><component :is="component" :data-character="activeChar" @vue:mounted="focusSpeechSettings" @save="onSpeechSettingsSaved" @close="speechSettingsOpen = false" /></AsyncPanel>
              </component>
              </AsyncPanel>
            </div>
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
            <StudioTooltip content="新对话"><button class="btn btn-ghost" type="button" aria-label="新对话" :disabled="busy || storyBusy" @click="clearCharacterConversation"><ArchiveIcon name="broom" /></button></StudioTooltip>
            <StudioTooltip content="聊天设置"><button class="btn btn-ghost chat-settings-trigger" type="button" aria-label="聊天设置" @click="openRoomPanel('settings')"><ArchiveIcon name="gear" /></button></StudioTooltip>
            <ChatActionsMenu @clear-all="clearAllMemory" @toggle-archive="openRoomPanel('archive')" @toggle-memory="openRoomPanel('memory')" @toggle-profile="openRoomPanel('profile')" />
          </div>
        </header>
        <ChatStoryPicker :branch-id="branchId" :branches="storyBranches" :disabled="busy || storyBusy || storage.writeBlocked.value"
          @select="handleStoryAction({ kind: 'switch-branch', branchId: $event })" />
        <div v-if="!chatReady || preparingRoom" class="room-setup">
          <strong><span class="room-setup-icon" aria-hidden="true"><ArchiveIcon name="model" /></span>{{ setupTitle }}</strong>
          <button v-if="chatProvider === 'local'" class="btn btn-primary btn-sm" type="button" :disabled="preparingRoom" @click="prepareRoom">{{ preparingRoom ? '准备中…' : '连接模型' }}</button>
          <button v-else class="btn btn-primary btn-sm" type="button" @click="apiSettingsOpen = true; openRoomPanel('settings')">选择模型</button>
        </div>
        <div v-show="!immersive" class="chat-list" ref="chatListRef" role="log" aria-live="off" aria-label="对话记录">
          <div v-if="!currentMessages.length" class="chat-empty">
            <div class="room-welcome-art" aria-hidden="true"><RuntimeImage class="room-empty-avatar" :src="avatar" alt="" /></div>
            <h2 class="room-empty-title">和{{ currentCharacter.name }}聊一会儿</h2>
            <div class="chat-empty-greeting">{{ personalizedGreeting }}</div>
            <div class="chat-starters" aria-label="对话开场建议"><button v-for="(s, index) in currentCharacter.starters" :key="s" class="room-starter" type="button" @click="chooseStarter(s)"><span class="room-starter-index" aria-hidden="true">{{ String(index + 1).padStart(2, '0') }}</span><span class="room-starter-copy">{{ s }}</span><span class="room-starter-arrow" aria-hidden="true"><ArchiveIcon name="chevron-down" /><ArchiveIcon name="chevron-down" /></span></button></div>
            <p class="room-starter-hint">选择开场建议后，可编辑再发送。</p>
          </div>
          <button v-if="hasEarlier" class="btn btn-ghost btn-sm" type="button" :disabled="paging" @click="loadEarlier">查看更早消息</button>
          <ChatMessageRow v-for="msg in visibleMessages" tabindex="-1" :key="msg.replyId || msg.mid" :message="msg" :avatar="avatar"
            :chibi="Boolean(companionChatAvatars[activeChar])" :streaming="msg.mid === streamingMid" :playing="msg.mid === playingMid"
            :remembered="Boolean(msg.mid && messageRemembered(msg.mid))" :has-audio="voice.hasAudio"
            :can-regenerate="chatReady && canRegenerateMessage(msg.mid)" :story-disabled="busy || storyBusy || storage.writeBlocked.value"
            @copy="copyMessage" @remember="rememberMessage" @play="voice.playMessage($event)"
            @regenerate="handleStoryAction({ kind: 'regenerate', messageId: msg.mid })" @fork="handleStoryAction({ kind: 'fork', messageId: msg.mid })"
            @select-variant="handleStoryAction({ kind: 'select-variant', messageId: msg.mid, variantId: $event })" />
          <button v-if="hasLater" class="btn btn-ghost btn-sm" type="button" :disabled="paging" @click="loadLater">查看后续消息</button>
        </div>
        <button v-if="!immersive && showLatest" class="room-latest btn btn-ghost" type="button" @click="latest">回到最新消息</button>
        <div v-if="immersive" class="room-current-line" role="log" aria-live="off" aria-label="最近一句回复"><p>{{ currentLine }}</p></div>
        <div v-if="activityText" class="room-chat-activity" role="status"><span>{{ activityText }}</span><button v-if="speechSessionActive" class="btn btn-ghost btn-sm btn-icon" type="button" aria-label="结束连续对话" @click="onSpeechSessionEnd"><ArchiveIcon name="close" /></button></div>
        <div class="chat-composer">
          <div class="room-composer-meta"><span><ArchiveIcon name="chat" />写给{{ currentCharacter.name }}</span><small><kbd>Enter</kbd> 发送 · <kbd>Shift + Enter</kbd> 换行</small></div>
          <div class="composer-row">
            <StudioTooltip v-if="speechReady" anchor :content="speechError || (busy || voiceActive ? '请等待当前回复或语音结束' : speechButtonText)">
              <button class="hold-talk-btn" type="button" :aria-label="speechButtonText" :data-state="speechState" :disabled="speechButtonDisabled"
                @keydown.space.prevent="speechHold.keyDown" @keydown.enter.prevent="speechHold.keyDown" @keyup="speechHold.keyUp"
                @blur="speechHold.cancelHeld" @pointerdown.prevent="speechHold.pointerDown" @pointerup="speechHold.pointerUp" @pointercancel="speechHold.pointerCancel" @lostpointercapture="speechHold.pointerCancel"><ArchiveIcon name="sound" /></button>
            </StudioTooltip>
            <textarea ref="inputRef" class="chat-input" v-model="inputText" rows="1" maxlength="1200" placeholder="发消息…" aria-label="聊天输入"
              @keydown.enter.exact="submitChatOnEnter($event, handleSend)" @input="onInputChange"></textarea>
            <StudioTooltip anchor :content="busy || voiceActive ? '停止回复或语音' : chatReady ? '发送 · Enter（Shift+Enter 换行）' : '请先连接聊天模型'">
              <StudioSendButton :busy="busy || voiceActive" :disabled="storyBusy || !chatReady || !inputText.trim() || storage.writeBlocked.value"
                :turn-id="lastUserMessage?.mid || ''" :completed="Boolean(replyAnnouncement) && !chatError && !lastAssistantMessage?.stopped"
                :context="activeChar" :message-host="chatListRef" @send="handleSend" @stop="stopEverything" />
            </StudioTooltip>
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
import StudioSendButton from '@/components/ui/StudioSendButton.vue'
import '@/assets/css/chat.css'
import '@/assets/css/conversation-room.css'
import { useChatHistoryWindow } from '@/composables/chat/useChatHistoryWindow'
import { isBackdropClick, useFluidDialog } from '@/composables/useFluidDialog'
import { useRoomPresentation } from '@/composables/chat/useRoomPresentation'
import { computed, defineAsyncComponent, nextTick, ref, watch } from 'vue'
import { useResizeObserver, useTextareaAutosize } from '@vueuse/core'
import { useCharacterRoomSession } from '@/composables/chat/useCharacterRoomSession'
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
const ChatStoryPicker = defineAsyncComponent(() => import('@/components/ChatStoryPicker.vue'))
const ChatMessageRow = defineAsyncComponent(() => import('@/components/ChatMessageRow.vue'))
// App's TaskCenter already loads this boundary before tools can open; keep its
// low-frequency use outside the room's static dependency closure.
const AsyncPanel = defineAsyncComponent(() => import('@/components/ui/AsyncPanel.vue'))
// The local boundary mounts portal controls in the visible dialog and owns import recovery.
const loadChatModelControls = () => import('@/components/ChatModelControls.vue')
const loadChatApiSettings = () => import('@/components/ChatApiSettings.vue')
const loadChatSearchSettings = () => import('@/components/ChatSearchSettings.vue')
const loadSpeechInputSettings = () => import('@/components/SpeechInputSettings.vue')
const loadSpeechPopover = () => import('@/components/ui/StudioPopover.vue')
// These panels mount only after a menu action; load their component CSS then too.
const roomToolLoaders = {
  archive: () => import('@/components/ChatArchivePanel.vue'),
  profile: () => import('@/components/ChatUserProfilePanel.vue'),
  memory: () => import('@/components/ChatMemoryPanel.vue'),
}

const {
  chatListRef,
  characterStageRef,
  activeChar,
  busy,
  voiceActive,
  voiceStatusText,
  chatError,
  chatErrorKind,
  voiceCapabilityText,
  showVoiceRecovery,
  playingMid,
  isSpeaking,
  autoVoice,
  volume,
  preparingRoom,
  storage,
  branchId, storyBranches, storyBusy, handleStoryAction, canRegenerateMessage,
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
} = useCharacterRoomSession({ latest: () => { void latest() }, nearBottom: () => !showLatest.value })
const lastUserMessage = computed(() => currentMessages.value.filter(message => message.role === 'user').at(-1))
const lastAssistantMessage = computed(() => currentMessages.value.filter(message => message.role === 'assistant').at(-1))

type RoomPanel = 'archive' | 'memory' | 'profile' | 'settings'
const roomPanel = ref<RoomPanel | null>(null)
const roomPanelGeneration = ref(0)
let roomPanelClosing = false
const roomPanelLabels = { archive: '对话归档', memory: '长期记忆', profile: '我的档案', settings: '聊天设置' }
const roomPanelDialog = ref<HTMLDialogElement | null>(null)
const roomPanelMotion = useFluidDialog(roomPanelDialog)
useResizeObserver(roomPanelDialog, () => {
  if (!speechSettingsOpen.value) return
  const dialog = roomPanelDialog.value
  const popover = dialog?.querySelector<HTMLElement>('.chat-speech-settings')
  const trigger = dialog?.querySelector<HTMLElement>('.room-settings-voice [aria-haspopup="dialog"]')
  const body = trigger?.closest<HTMLElement>('.room-tool-body')
  if (!trigger || !body || (document.activeElement !== document.body && !popover?.contains(document.activeElement))) return
  const bounds = body.getBoundingClientRect(), anchor = trigger.getBoundingClientRect()
  if (anchor.top >= bounds.top && anchor.bottom <= bounds.bottom) return
  // Keep the draft mounted when a smaller viewport clips Reka's anchor.
  trigger.scrollIntoView({ block:'nearest', inline:'nearest', behavior:'instant' })
  trigger.focus({ preventScroll:true })
}, { box:'border-box' })
async function openRoomPanel(panel: RoomPanel) {
  roomPanelClosing = false
  const generation = ++roomPanelGeneration.value
  roomPanel.value = panel
  await nextTick()
  if (roomPanelClosing || roomPanel.value !== panel || generation !== roomPanelGeneration.value) return
  roomPanelMotion.open(document.querySelector<HTMLElement>(panel === 'settings' ? '.chat-settings-trigger' : '.chat-more-trigger'))
  void focusRoomPanel()
}
async function focusRoomPanel() {
  const generation = roomPanelGeneration.value
  await nextTick()
  const dialog = roomPanelDialog.value, active = document.activeElement
  if (!dialog?.open || roomPanelClosing || !roomPanel.value || generation !== roomPanelGeneration.value) return
  // Loading removes its close button on resolve; preserve focus already moved into the ready panel or a nested portal.
  if (active && active !== document.body && active !== dialog && active !== dialog.querySelector('.room-panel-content > .async-panel')) return
  dialog.querySelector<HTMLElement>('.room-panel-content button')?.focus({ preventScroll: true })
}
function clearRoomPanel() { roomPanel.value = null; apiSettingsOpen.value = false; speechSettingsOpen.value = false }
function closeRoomPanel() { roomPanelClosing = true; speechSettingsOpen.value = false; roomPanelMotion.close(clearRoomPanel) }
function onRoomPanelClosed() { if (!roomPanelDialog.value?.open) clearRoomPanel() }
function closeRoomPanelFromBackdrop(event: MouseEvent) {
  if (isBackdropClick(event, roomPanelDialog.value)) closeRoomPanel()
}
const immersive = ref(false)
const presentationSuspended = useRoomPresentation('room')
const { visibleMessages, hasEarlier, hasLater, paging, showLatest, latest, loadEarlier, loadLater } = useChatHistoryWindow(chatListRef, currentMessages, computed(() => `${activeChar.value}:${branchId.value}`))
const currentLine = computed(() => lastAssistantMessage.value?.content || personalizedGreeting.value)
function chooseStarter(text: string) { useStarter(text); void nextTick(() => inputRef.value?.focus()) }
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
  speechHold,
  onSpeechSettingsSaved,
  onSpeechSessionEnd,
} = useChatSpeechInteraction({
  currentCharacter,
  chatReady,
  busy: computed(() => busy.value || storyBusy.value || voiceActive.value || roomPanel.value === 'settings'),
  inputText,
  onInputChange,
  handleSend: accepted => handleSend(undefined, undefined, accepted),
})
watch([apiSettingsOpen, speechSettingsOpen], ([api, speech]) => {
  if ((api || speech) && !roomPanelClosing && roomPanel.value !== 'settings') void openRoomPanel('settings')
}, { immediate: true })
const avatar = computed(() => companionChatAvatars[activeChar.value] || characterArtEntry(activeChar.value)?.thumbnailUrl || resolveCompanionAvatar(activeChar.value)?.avatar.thumbnailUrl || currentCharacter.value.image)
const activityText = computed(() => toolActivity.value || (thinkingActivity.value ? '思考中…' : '')
  || (speechState.value === 'error' ? speechError.value : '')
  || (voiceActive.value ? voiceStatusText.value : '') || (isSpeaking.value ? '正在说话' : '') || (busy.value ? '正在回复…' : '')
  || (['acquiring', 'capturing', 'recognizing'].includes(speechState.value) ? speechButtonText.value : '')
  || speechNotice.value || (speechSessionActive.value ? '连续对话中' : speechAutoListening.value ? '听候唤醒' : ''))
const inputRef = ref<HTMLTextAreaElement>()
watch(branchId, () => { void nextTick(() => inputRef.value?.focus({ preventScroll: true })) })
useTextareaAutosize({ element:inputRef, input:inputText, maxHeight:120 })
async function focusSpeechPopover(event: Event) {
  event.preventDefault()
  const opener = document.activeElement
  await nextTick()
  const panel = document.querySelector<HTMLElement>('.chat-speech-settings')
  if (!speechSettingsOpen.value || !panel || (document.activeElement !== opener && !panel.contains(document.activeElement))) return
  ;(panel.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled)') || panel).focus({ preventScroll: true })
}
function returnSpeechFocus(event: Event) {
  const dialog = roomPanelDialog.value, active = document.activeElement
  if (!dialog?.open || (active !== document.body && !active?.closest('.chat-speech-settings'))) return
  const trigger = dialog.querySelector<HTMLElement>('.room-settings-voice [aria-haspopup="dialog"]')
  if (trigger) { event.preventDefault(); trigger.focus({ preventScroll:true }) }
}
function focusSpeechSettings() {
  const panel = document.querySelector<HTMLElement>('.chat-speech-settings')
  // An uncached editor arrives after Reka focuses the empty popover. Preserve
  // any focus the user has moved elsewhere while it was loading.
  if (speechSettingsOpen.value && (panel === document.activeElement || panel?.querySelector(':scope > .async-panel') === document.activeElement))
    panel?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled)')?.focus({ preventScroll: true })
}
</script>
