<template>
  <article
    tabindex="-1"
    class="companion-page companion-redesign"
    :data-character="activeChar"
    :data-power-mode="desktopBridge ? (onBatteryPower ? 'efficiency' : 'quality') : undefined"
    :data-ui-hidden="uiHidden || undefined"
    :data-presence="presence.kind"
    :data-controls-open="petGestures.controlsOpen.value || undefined"
    @contextmenu="petGestures.contextMenu"
    @pointerdown.capture="petGestures.beginDrag"
    @click.capture="petGestures.click"
    @dblclick="petGestures.doubleClick"
  >
    <button v-if="desktopBridge && !immersive" type="button" class="skip-link" :aria-expanded="petGestures.controlsOpen.value"
      @click="petGestures.controlsOpen.value = !petGestures.controlsOpen.value">桌宠菜单</button>
    <header class="companion-toolbar" :class="{ 'companion-orbit-preferences-host': desktopBridge }" :data-hidden="immersive ? 'true' : undefined">
      <div class="companion-identity" aria-live="polite">
        <span>陪伴模式</span>
        <h1>与{{ currentCharacter.name }}相伴</h1>
      </div>
      <AsyncPanel class="companion-picker-host" :loader="loadCharacterPicker" label="角色选择">
        <template #default="{ component }"><component :is="component" :model-value="activeChar" label="切换陪伴角色" @update:model-value="switchPetCharacter" /></template>
        <template #feedback="{ failed, retry }"><button v-if="failed" class="btn btn-ghost btn-sm" type="button" @click="retry">重新加载</button><span v-else role="status">正在加载角色列表…</span></template>
      </AsyncPanel>
      <div class="companion-toolbar-actions">
        <CompanionPreferences v-model:open="settingsOpen" :desktop="Boolean(desktopBridge)" :character-id="activeChar" :character-name="currentCharacter.name">
        <template #trigger><button
          type="button"
          class="companion-settings-btn"
          aria-label="设置"
          :aria-expanded="settingsOpen"
          @click="desktopBridge && (settingsOpen = !settingsOpen)"
        ><ArchiveIcon name="gear" /><span>设置</span></button></template>
          <div class="companion-pop-group" data-preference-pane="character">
            <strong>角色外观</strong>
            <button type="button" class="companion-pop-item" @click="openAppearance"><ArchiveIcon name="wardrobe" /><span>角色取景与外观</span><ArchiveIcon class="preference-chevron" name="chevron-down" /></button>
            <Live2DQualityControl />
          </div>
          <div class="companion-pop-group" data-preference-pane="companion">
            <strong>声音与问候</strong>
            <span class="companion-pop-item">{{ affectionInfo.title }} · {{ affectionScore }}</span>
            <ToggleSwitch class="companion-pop-item companion-pop-switch" :model-value="autoVoice" label="实时配音" @update:model-value="setAutoVoice">
              <StudioTooltip content="播放聊天回复和新问候；勿扰时暂停主动问候">
                <span>实时配音：{{ autoVoice ? '开' : '关' }}</span>
              </StudioTooltip>
            </ToggleSwitch>
            <ToggleSwitch v-if="behaviorEnabled" class="companion-pop-item companion-pop-switch" :model-value="dnd" label="勿扰模式" @update:model-value="toggleDnd">
              <span>勿扰模式<small>暂停主动问候</small></span>
            </ToggleSwitch>
            <label class="companion-pop-item companion-pop-volume"><span>音量 <small>{{ volume }}%</small></span>
              <input type="range" v-model.number="volume" min="0" max="100" aria-label="桌宠音量" @input="onVolumeChange" />
            </label>
          </div>
          <input
            ref="importInputRef"
            class="sr-only"
            type="file"
            hidden
            accept="image/*"
            multiple
            aria-label="导入本地图片到作品册"
            @change="onImportInputChange"
          />
          <div class="companion-pop-group" data-preference-pane="more">
            <strong>界面偏好</strong>
            <AppearancePreferences launcher-only @open="settingsOpen = false" />
            <StudioTooltip content="沉浸模式：只保留角色与对话（Esc 退出）">
              <button v-if="desktopBridge" type="button" class="companion-pop-item" @click="settingsOpen = false; petGestures.controlsOpen.value = false; enterImmersive()"><ArchiveIcon name="moon" /><span>沉浸模式</span></button>
            </StudioTooltip>
          </div>
          <div class="companion-pop-group" data-preference-pane="more">
            <strong>工作台</strong>
            <StudioTooltip content="打开绘图画室（Ctrl+Shift+A）">
              <button type="button" class="companion-pop-item" @click="desktopBridge ? desktopBridge.openAtelier() : $router.push('/prompt-builder')"><ArchiveIcon name="palette" /><span>打开绘图画室</span></button>
            </StudioTooltip>
            <button v-if="desktopBridge" type="button" class="companion-pop-item" @click="desktopBridge.openAtelier(`/chat?character=${encodeURIComponent(activeChar)}`)"><ArchiveIcon name="chat" /><span>进入角色房间</span></button>
            <button v-if="desktopBridge" type="button" class="companion-pop-item" @click="desktopBridge.openAtelier('/control#control-companion-channels')"><ArchiveIcon name="chat" /><span>手机聊天连接</span></button>
            <RouterLink v-else class="companion-pop-item" :to="{ path: '/chat', query: { character: activeChar } }">进入角色房间</RouterLink>
            <button type="button" class="companion-pop-item" @click="openImportPicker"><ArchiveIcon name="image" /><span>导入图片到作品册</span></button>
          </div>
          <div v-if="desktopBridge" class="companion-pop-group" data-preference-pane="more">
            <strong>本机资源</strong>
            <StudioTooltip :content="workspaceTooltip">
              <button
                ref="workspaceTriggerEl"
                type="button"
                class="companion-pop-item"
                :data-state="workspaceExists && !workspaceRestartRequired ? 'ok' : 'missing'"
                aria-haspopup="dialog"
                :aria-expanded="workspaceOpen"
                aria-controls="companion-workspace-settings"
                @click="toggleWorkspace"
              >
                <ArchiveIcon :name="workspaceExists ? 'success' : 'error'" />
                <span>{{ workspaceRestartRequired ? '工作区待重启生效' : workspaceExists ? 'AI 工作区已配置' : 'AI 工作区缺失' }}</span>
              </button>
            </StudioTooltip>
          </div>
        </CompanionPreferences>
      </div>
    </header>

    <main class="companion-stage" aria-label="桌面陪伴模式" :data-immersive="immersive ? 'true' : undefined">
      <StudioTooltip v-if="desktopBridge && immersive" content="退出沉浸模式（Esc）">
        <button
          class="companion-exit-immersive"
          type="button"
          @click="exitImmersive"
        >退出沉浸</button>
      </StudioTooltip>
      <ChatCardPortrait v-if="activeChar.startsWith('card-')" :character="currentCharacter" />
      <ChatCharacterStage v-else
        ref="characterStageRef"
        surface="companion"
        :suspended="presentationSuspended"
        :active-id="activeChar"
        :character="currentCharacter"
        :speaking="isSpeaking"
        :volume="volume"
        :chat-status-text="chatStatusText"
        :status-kind="statusKind"
        :auto-load="companionAutoLoad"
        :presence="presence.kind"
        :backend="desktopBridge ? 'native' : 'browser'"
        :desktop-window-bounds="desktopWindowBounds"
        :outfit="storage.live2dOutfit(activeChar)"
        @select="switchCharacter"
        @live2d-enabled="handleLive2dPreference"
        @outfit-changed="storage.setLive2dOutfit(activeChar, $event)"
      />
      <div
        class="companion-presence-cue"
        :data-state="presence.kind"
        role="status"
        aria-live="polite"
      >
        <i aria-hidden="true"></i>
        <span>{{ presence.label }}</span>
      </div>

      <section v-content-motion:fade="activeChar" class="companion-conversation" aria-label="简洁对话">
        <TransitionGroup
          v-if="behaviorEnabled && pendingReminders.length"
          name="reminder-pop"
          tag="div"
          class="companion-reminders"
          role="log"
          aria-label="角色主动问候"
        >
          <div
            v-for="reminder in pendingReminders"
            :key="reminder.id"
            class="companion-reminder-bubble"
            :data-kind="reminder.kind"
            :data-event-kind="reminder.eventKind || undefined"
            :class="{ 'companion-reminder-link': reminder.kind === 'event' && reminder.eventKind && desktopBridge }"
          >
            <span class="companion-reminder-name">{{ currentCharacter.name }}</span>
            <p>{{ reminder.line }}</p>
            <div v-if="reminder.kind === 'event' && reminder.eventKind && desktopBridge" class="companion-reminder-actions">
              <button type="button" class="companion-reminder-action" @click="openReminderRoute(reminder)">{{ reminderActionLabel(reminder) }}</button>
            </div>
            <button type="button" class="companion-reminder-dismiss" aria-label="关闭这条问候" @click="dismissReminder(reminder.id)"><ArchiveIcon name="close" /></button>
          </div>
        </TransitionGroup>
        <CompanionClipboardCard :card="clipboardCard" :character-name="currentCharacter.name"
          @inspect="inspectClipboardImage" @accept="acceptClipboardCard" @dismiss="dismissClipboardCard" />
        <CompanionImportRecovery v-if="!desktopBridge" :recovery="importRecovery" />
        <div ref="chatListRef" class="companion-bubbles" role="log" aria-live="off" :aria-busy="busy" aria-label="最近对话">
          <div v-if="!companionMessages.length" class="companion-empty">
            <span>{{ currentCharacter.name }}</span>
            <p>{{ currentCharacter.greeting }}</p>
          </div>
          <template v-else>
            <div
              v-for="msg in immersiveMessages"
              :key="msg.mid"
              class="companion-bubble"
              :class="msg.role"
            >
              <span>{{ msg.role === 'user' ? '你' : currentCharacter.name }}</span>
              <p v-if="msg.content">{{ msg.content }}</p>
              <ChatMessageAttachments :message="msg" />
            </div>
          </template>
        </div>
        <button v-if="hasNewMessages" class="btn btn-ghost btn-sm companion-back-latest" type="button" @click="latestMessages">回到最新</button>

        <ChatTurnIndicator v-if="toolActivity || thinkingActivity || busy" class="companion-tool-indicator"
          :label="toolActivity || (thinkingActivity ? '思考中…' : '正在回复…')" animated />

        <div class="companion-composer">
          <VoiceGlow v-if="glowMounted"
            :active="glowActive"
            :level="speechLevel"
            :processing="busy || speechState === 'recognizing'"
            color-variant="dual"
          />
          <div
            v-if="!chatReady || preparingRoom"
            class="companion-setup-inline"
            :data-state="preparingRoom ? 'active' : 'warning'"
          >
            <ArchiveIcon name="gear" />
            <span>{{ setupTitle }}</span>
            <button
              v-if="chatProvider === 'local' || (chatReady && voiceCapabilityState === 'offline')"
              class="companion-setup-action"
              type="button"
              :disabled="preparingRoom"
              @click="prepareRoom"
            >{{ preparingRoom ? '准备中…' : '准备环境' }}</button>
            <RouterLink v-else class="companion-setup-action" to="/chat">前往配置</RouterLink>
          </div>
          <ConversationComposer density="room" has-tools>
            <label class="sr-only" for="companion-chat-input">桌宠聊天输入</label>
            <textarea id="companion-chat-input"
              v-model="inputText" class="companion-input" rows="2" maxlength="1200"
              :placeholder="`对${currentCharacter.name}说…`"
              @focus="composerFocused = true" @blur="composerFocused = false"
              @keydown.enter.exact="submitChatOnEnter($event, handleSend)" @input="onInputChange"
            ></textarea>
            <template #tools>
              <StudioTooltip v-if="chatProvider !== 'muse'" anchor :content="capturingScreen ? '正在读取画面…' : `让${currentCharacter.name}看你当前的屏幕画面`">
                <button class="companion-vision-btn" type="button" :disabled="busy || !chatReady || capturingScreen" aria-label="看屏幕" @click="onCaptureAndInspectScreen">
                  <ArchiveIcon name="eye" />
                </button>
              </StudioTooltip>
              <StudioTooltip v-if="speechReady" anchor :content="speechError || '按住说话，松开识别；也可按住 Space'">
                <button
                  class="companion-speech-btn"
                  type="button"
                  :data-state="speechState"
                  :aria-label="speechButtonText"
                  :disabled="speechButtonDisabled"
                  @pointerdown.prevent="speechHold.pointerDown"
                  @pointerup="speechHold.pointerUp"
                  @pointercancel="speechHold.pointerCancel"
                  @lostpointercapture="speechHold.pointerCancel"
                  @keydown.space.prevent="speechHold.keyDown" @keydown.enter.prevent="speechHold.keyDown" @keyup="speechHold.keyUp"
                  @blur="speechHold.cancelHeld"
                ><ArchiveIcon name="sound" /></button>
              </StudioTooltip>
              <StudioPopover v-model:open="speechSettingsOpen" label="语音输入设置" side="top" prioritize-position content-class="companion-speech-settings speech-settings-popover" @open-auto-focus="focusSpeechPopover">
                <template #trigger><button class="btn btn-ghost btn-sm" type="button" aria-label="语音输入设置">语音设置</button></template>
                <AsyncPanel v-if="speechSettingsOpen" :loader="loadSpeechInputSettings" label="语音输入设置" v-slot="{ component }"><component :is="component" :data-character="activeChar" @vue:mounted="focusSpeechSettings" @save="onSpeechSettingsSaved" @close="speechSettingsOpen = false" /></AsyncPanel>
              </StudioPopover>
            </template>
            <template #commit>
              <button :class="busy || voiceActive ? 'companion-stop' : 'companion-send'" type="button"
                :disabled="!(busy || voiceActive) && (!chatReady || !inputText.trim())"
                @click="busy || voiceActive ? stopEverything() : handleSend()">{{ busy || voiceActive ? '停止' : '发送' }}</button>
            </template>
          </ConversationComposer>
           <div v-if="chatReady || voiceStatusText || speechStateText || speechAutoListening || speechSessionActive || inQuietHours" class="companion-composer-meta" aria-live="polite">
             <span v-if="chatReady" class="companion-chat-status">{{ chatStatusText }}</span>
             <span v-if="voiceStatusText" class="companion-voice-status">{{ voiceStatusText }}</span>
             <span v-if="speechReady && speechState !== 'error' && (speechStateText || speechAutoListening)" class="companion-speech-state">{{ speechStateText || '听候唤醒' }}</span>
             <button v-if="speechSessionActive" class="btn btn-ghost btn-sm" type="button" @click="onSpeechSessionEnd">结束连续对话<ArchiveIcon name="close" /></button>
             <StudioTooltip v-if="inQuietHours" :content="quietHoursText">
               <span class="companion-quiet-hours-hint"><ArchiveIcon name="moon" /> 安静时段</span>
             </StudioTooltip>
           </div>
         </div>

        <div v-if="(speechState === 'error' && speechError) || chatError" class="companion-errors">
          <div v-if="speechState === 'error' && speechError && speechError !== chatError" class="companion-error" role="status">{{ speechError }}</div>
          <div v-if="chatError" class="companion-error" role="status" :data-kind="chatErrorKind">{{ chatError }}</div>
        </div>
        <p class="sr-only" role="status" aria-live="polite">{{ replyAnnouncement }}</p>
      </section>

      <CompanionWorkspaceSettings
        :open="workspaceOpen"
        :model-value="workspaceInput"
        :saving="workspaceSaving"
        :error="workspaceError"
        :return-focus-el="workspaceTriggerEl"
        @close="closeWorkspace"
        @save="saveWorkspace"
        @update:model-value="workspaceInput = $event"
      />

      <CompanionOrbitMenu v-if="desktopBridge" :open="petGestures.controlsOpen.value" :character-id="activeChar"
        :pinned="alwaysOnTop" :pass-through="ignoreMouseEvents"
        :controls="characterStageRef?.petControls" :set-expression="characterStageRef?.setPetExpression"
        @close="petGestures.controlsOpen.value = false" @settings="settingsOpen = true" @appearance="openAppearance"
        @chat="openChatWindow" @pin="togglePin" @pass="toggleMouseEvents" @hide="desktopBridge.hide"
        @character="switchPetCharacter" @motion="characterStageRef?.playPetMotion?.($event)" />
      <!-- 真双窗口（桌面）浮层：角色为主，聊天独立窗口。 -->
      <CompanionDesktopFloat
        v-if="desktopBridge"
        :inert="immersive || undefined"
        :reply-announcement="replyAnnouncement"
        :character-name="currentCharacter.name"
        :chat-error="chatError"
        :reminders="pendingReminders"
        :live-dot-state="liveDotState"
        :live-dot-text="liveDotText"
        :speech-capturing="speechState === 'capturing'"
        :speech-auto-listening="speechAutoListening"
        :show-watch="!immersive && (petGestures.controlsOpen.value || screenWatch.state.value !== 'idle' || Boolean(screenWatch.notice.value))"
        :show-chat="!petGestures.controlsOpen.value"
        @open-chat="openChatWindow"
        @open-atelier="desktopBridge.openAtelier()"
        @open-reminder="openReminderRoute"
        @dismiss-reminder="dismissReminder"
      >
        <template #watch><CompanionScreenWatch :controller="screenWatch" show-entry docked /></template>
        <template #import-recovery><CompanionImportRecoveryDialog :recovery="importRecovery" :character-id="activeChar" compact /></template>
      </CompanionDesktopFloat>
      <CompanionScreenWatch v-if="!desktopBridge || immersive" :controller="screenWatch" show-entry />
    </main>
  </article>
</template>

<script setup lang="ts">

import CompanionPreferences from '@/components/CompanionPreferences.vue'
import { computed, defineAsyncComponent, nextTick, ref, watch } from 'vue'
const VoiceGlow = defineAsyncComponent(() => import('@/components/visual/VoiceGlow.vue'))
const CompanionScreenWatch = defineAsyncComponent(() => import('@/components/CompanionScreenWatch.vue'))
const ConversationComposer = defineAsyncComponent(() => import('@/components/ConversationComposer.vue'))
const ChatTurnIndicator = defineAsyncComponent(() => import('@/components/ChatTurnIndicator.vue'))
const CompanionOrbitMenu = defineAsyncComponent(() => import('@/components/CompanionOrbitMenu.vue'))
const CompanionClipboardCard = defineAsyncComponent(() => import('@/components/CompanionClipboardCard.vue'))
const CompanionImportRecovery = defineAsyncComponent(() => import('@/components/CompanionImportRecovery.vue'))
const CompanionImportRecoveryDialog = defineAsyncComponent(() => import('@/components/CompanionImportRecoveryDialog.vue'))
const AppearancePreferences = defineAsyncComponent(() => import('@/components/AppearancePreferences.vue'))
import '@/assets/css/companion.css'
import '@/assets/css/companion-surface.css'
const loadCharacterPicker = () => import('@/components/CompanionCharacterPicker.vue')
const CompanionDesktopFloat = defineAsyncComponent(() => import('@/components/CompanionDesktopFloat.vue'))
const CompanionWorkspaceSettings = defineAsyncComponent(() => import('@/components/CompanionWorkspaceSettings.vue'))
import ToggleSwitch from '@/components/visual/ToggleSwitch.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import StudioPopover from '@/components/ui/StudioPopover.vue'
import { usePetGestures } from '@/composables/chat/usePetGestures'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { submitChatOnEnter } from '@/utils/chatInput'
const ChatCharacterStage = defineAsyncComponent(() => import('@/components/ChatCharacterStage.vue'))
const ChatCardPortrait = defineAsyncComponent(() => import('@/components/ChatCardPortrait.vue'))
const ChatMessageAttachments = defineAsyncComponent(() => import('@/components/ChatMessageAttachments.vue'))
// Quality settings are rendered only after the preferences slot is revealed.
const Live2DQualityControl = defineAsyncComponent(() => import('@/components/Live2DQualityControl.vue'))
import AsyncPanel from '@/components/ui/AsyncPanel.vue'
const loadSpeechInputSettings = () => import('@/components/SpeechInputSettings.vue')
import { useCompanionWorkspace } from "@/composables/chat/useCompanionWorkspace"
const {
chatListRef,characterStageRef,activeChar,
desktopBridge,
presentationSuspended,
onBatteryPower,
uiHidden,
presence,
immersive,
currentCharacter,
affectionScore,
affectionInfo,
switchCharacter,
settingsOpen,
autoVoice,
onAutoVoiceChange,
behaviorEnabled,
dnd,
toggleDnd,
importInputRef, importRecovery, openImportPicker,
onImportInputChange,
alwaysOnTop,
togglePin,
ignoreMouseEvents,
toggleMouseEvents,
enterImmersive,
workspaceExists,
workspaceRestartRequired,
workspaceTooltip,
workspaceOpen,
volume,
onVolumeChange,
exitImmersive,
isSpeaking,
chatStatusText,
statusKind,
companionAutoLoad,
desktopWindowBounds,
storage,
handleLive2dPreference,
pendingReminders,
openReminderRoute,
dismissReminder,
clipboardCard,
inspectClipboardImage,
acceptClipboardCard,
dismissClipboardCard,
companionMessages,
immersiveMessages,
hasNewMessages,
latestMessages,
toolActivity,
thinkingActivity,
chatReady,
voiceCapabilityState,
preparingRoom,
setupTitle,
chatProvider,
prepareRoom,
inputText,
composerFocused,
handleSend,
onInputChange,
busy,
capturingScreen,
onCaptureAndInspectScreen,
voiceActive,
stopEverything,
speechReady,
speechState,
speechLevel,
speechButtonDisabled,
speechError,
speechHold,
speechButtonText,
speechStateText,
speechAutoListening,
speechSessionActive,
onSpeechSessionEnd,
speechSettingsOpen,
voiceStatusText,
inQuietHours,
quietHoursText,
onSpeechSettingsSaved,
chatErrorKind,
chatError,
replyAnnouncement,
workspaceInput,
saveWorkspace,
workspaceSaving,
workspaceError,
openChatWindow,
liveDotState,
liveDotText,
screenWatch
} = useCompanionWorkspace()
const glowActive = computed(() => !presentationSuspended.value && !uiHidden.value && (composerFocused.value
  || speechState.value === 'capturing' || speechState.value === 'recognizing' || speechAutoListening.value || voiceActive.value || busy.value))
const glowMounted = ref(false)
watch(glowActive, active => { if (active) glowMounted.value = true }, { immediate: true })

const workspaceTriggerEl = ref<HTMLButtonElement | null>(null)

function toggleWorkspace() {
  workspaceOpen.value = !workspaceOpen.value
}

function closeWorkspace() {
  workspaceOpen.value = false
}

const petGestures = usePetGestures(desktopBridge, openChatWindow)
watch(petGestures.controlsOpen, open => { if (!open) settingsOpen.value = false })

function openAppearance() {
  settingsOpen.value = false
  characterStageRef.value?.openSettings?.()
}

function switchPetCharacter(id: string) {
  switchCharacter(id)
  petGestures.controlsOpen.value = false
}

function setAutoVoice(enabled: boolean) {
  autoVoice.value = enabled
  onAutoVoiceChange()
}

async function focusSpeechPopover(event: Event) {
  event.preventDefault()
  const opener = document.activeElement
  await nextTick()
  const panel = document.querySelector<HTMLElement>('.companion-speech-settings')
  if (!speechSettingsOpen.value || !panel || (document.activeElement !== opener && !panel.contains(document.activeElement))) return
  ;(panel.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled)') || panel).focus({ preventScroll:true })
}

function focusSpeechSettings() {
  const panel = document.querySelector<HTMLElement>('.companion-speech-settings')
  if (speechSettingsOpen.value && (panel === document.activeElement || panel?.querySelector(':scope > .async-panel') === document.activeElement))
    panel?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled)')?.focus({ preventScroll:true })
}

function reminderActionLabel(reminder: { eventKind?: string }) { return reminder.eventKind === 'image-ready' ? '打开任务中心' : '查看控制面板' }
</script>
