<template>
  <article
    tabindex="-1"
    class="companion-page"
    :class="{ 'has-character-picker': companionCharacters.length > 3, 'companion-redesign': true }"
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
    <div class="companion-ambience" aria-hidden="true">
      <i></i><i></i><i></i>
    </div>
    <header class="companion-toolbar" :class="{ 'companion-orbit-preferences-host': desktopBridge }" :data-hidden="immersive ? 'true' : undefined">
      <div class="companion-identity" aria-live="polite">
        <span>陪伴模式</span>
        <h1>与{{ currentCharacter.name }}相伴</h1>
      </div>
      <CompanionCharacterPicker :model-value="activeChar" label="切换陪伴角色" @update:model-value="switchPetCharacter" />
      <div class="companion-toolbar-actions">
        <button
          type="button"
          class="companion-settings-btn"
          aria-label="设置"
          :aria-expanded="settingsOpen"
          @click="settingsOpen = !settingsOpen"
        ><ArchiveIcon name="gear" /><span>设置</span></button>
        <CompanionPreferences v-model:open="settingsOpen" :desktop="Boolean(desktopBridge)" :character-id="activeChar" :character-name="currentCharacter.name">
          <div class="companion-pop-group" data-preference-pane="character">
            <strong>角色外观</strong>
            <button type="button" class="companion-pop-item" @click="openAppearance"><ArchiveIcon name="wardrobe" /><span>角色取景与外观</span><ArchiveIcon class="preference-chevron" name="chevron-down" /></button>
            <Live2DQualityControl :native="Boolean(desktopBridge)" />
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
            <StudioTooltip content="打开完整工作台（Ctrl+Shift+A）">
              <button type="button" class="companion-pop-item" @click="desktopBridge ? desktopBridge.openAtelier() : $router.push('/prompt-builder')"><ArchiveIcon name="palette" /><span>打开完整工作台</span></button>
            </StudioTooltip>
            <button v-if="desktopBridge" type="button" class="companion-pop-item" @click="desktopBridge.openAtelier(`/chat?character=${encodeURIComponent(activeChar)}`)"><ArchiveIcon name="chat" /><span>完整房间（聊天）</span></button>
            <RouterLink v-else class="companion-pop-item" :to="{ path: '/chat', query: { character: activeChar } }">完整房间（聊天）</RouterLink>
            <button type="button" class="companion-pop-item" @click="importInputRef?.click()"><ArchiveIcon name="image" /><span>导入图片到作品册</span></button>
          </div>
          <div v-if="desktopBridge" class="companion-pop-group" data-preference-pane="more">
            <strong>本机资源</strong>
            <StudioTooltip :content="workspaceTooltip">
              <button
                ref="workspaceTriggerEl"
                type="button"
                class="companion-pop-item"
                :data-state="workspaceExists ? 'ok' : 'missing'"
                aria-haspopup="dialog"
                :aria-expanded="workspaceOpen"
                aria-controls="companion-workspace-settings"
                @click="toggleWorkspace"
              >
                <ArchiveIcon :name="workspaceExists ? 'success' : 'error'" />
                <span>{{ workspaceExists ? 'AI 工作区已就绪' : 'AI 工作区缺失' }}</span>
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
      <ChatCharacterStage
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

      <section class="companion-conversation" aria-label="简洁对话">
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
        <div ref="chatListRef" class="companion-bubbles" role="log" aria-label="最近对话">
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
              <p>{{ msg.content }}</p>
            </div>
          </template>
        </div>
        <button v-if="hasNewMessages" class="btn btn-ghost btn-sm companion-back-latest" type="button" @click="latestMessages">回到最新</button>

        <div v-if="toolActivity || thinkingActivity" class="companion-tool-indicator" role="status">
          <ArchiveIcon :name="toolActivity ? 'gear' : 'spark'" /> {{ toolActivity || '思考中…' }}
        </div>

        <div class="companion-composer">
          <VoiceGlow
            :active="!presentationSuspended && !uiHidden && (composerFocused || speechState === 'capturing' || speechState === 'recognizing' || speechAutoListening || voiceActive || busy)"
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
          <textarea
            class="companion-input"
            v-model="inputText"
            rows="2"
            maxlength="1200"
            placeholder="对她说点什么……"
            aria-label="桌宠聊天输入"
            @focus="composerFocused = true"
            @blur="composerFocused = false"
            @keydown.enter.exact="submitChatOnEnter($event, handleSend)"
            @input="onInputChange"
          ></textarea>
          <StudioTooltip anchor :content="`让${currentCharacter.name}看你当前的屏幕画面`">
            <button class="companion-vision-btn" type="button" :disabled="busy || !chatReady || capturingScreen" aria-label="看屏幕" @click="onCaptureAndInspectScreen">
              <ArchiveIcon name="eye" />
              <span>{{ capturingScreen ? '看屏中…' : '看屏幕' }}</span>
            </button>
          </StudioTooltip>
          <button v-if="busy || voiceActive" class="companion-stop" type="button" @click="stopEverything">停止</button>
          <button class="companion-send" type="button" :disabled="busy || !chatReady" @click="handleSend">{{ busy ? '回复中' : '发送' }}</button>
           <div v-if="speechReady" class="companion-speech-cluster">
            <StudioTooltip anchor :content="speechError || '按住说话，松开识别；也可按住 Space'">
              <button
                class="companion-speech-btn"
                type="button"
                :data-state="speechState"
                :disabled="speechButtonDisabled"
                @pointerdown.prevent="onSpeechPress"
                @pointerup="onSpeechRelease"
                @pointercancel="onSpeechCancel"
                @pointerleave="onSpeechLeave"
              >{{ speechButtonText }}</button>
            </StudioTooltip>
            <span class="companion-speech-state" role="status" aria-live="polite">
              {{ speechStateText || (speechAutoListening ? '听候唤醒' : '') }}
            </span>
             <span v-if="speechSessionActive" class="companion-speech-session" role="status">
               连续对话中
               <StudioTooltip content="结束连续对话">
                 <button
                   class="companion-speech-session-end"
                   type="button"
                   aria-label="结束连续对话"
                   @click="onSpeechSessionEnd"
                 >×</button>
               </StudioTooltip>
             </span>
            <StudioTooltip content="语音输入设置">
              <button
                class="companion-speech-settings"
                type="button"
                aria-label="语音输入设置"
                @click="speechSettingsOpen = !speechSettingsOpen"
              >设置</button>
            </StudioTooltip>
           </div>
           <div v-else class="companion-speech-cluster">
            <StudioTooltip content="配置语音输入">
              <button
                class="companion-speech-settings"
                type="button"
                aria-label="配置语音输入"
                @click="speechSettingsOpen = true"
              >语音设置</button>
            </StudioTooltip>
           </div>
           <div class="companion-composer-meta" aria-live="polite">
             <span class="companion-chat-status">{{ chatStatusText }}</span>
             <span v-if="voiceStatusText" class="companion-voice-status">{{ voiceStatusText }}</span>
             <StudioTooltip v-if="inQuietHours" :content="quietHoursText">
               <span class="companion-quiet-hours-hint"><ArchiveIcon name="moon" /> 安静时段</span>
             </StudioTooltip>
           </div>
         </div>

        <SpeechInputSettings
          v-if="speechSettingsOpen"
          @save="onSpeechSettingsSaved"
          @close="speechSettingsOpen = false"
        />

        <div v-show="chatError" class="companion-error" role="status" aria-live="polite" :data-kind="chatErrorKind">
          {{ chatError }}
        </div>
        <p class="sr-only" role="status" aria-live="polite">{{ replyAnnouncement }}</p>
      </section>

      <CompanionWorkspaceSettings
        :open="workspaceOpen"
        :model-value="workspaceInput"
        :saving="workspaceSaving"
        :return-focus-el="workspaceTriggerEl"
        @close="closeWorkspace"
        @save="saveWorkspace"
        @update:model-value="workspaceInput = $event"
      />

      <!-- 真双窗口（桌面）浮层：角色为主，聊天独立窗口。 -->
      <CompanionDesktopFloat
        v-if="desktopBridge"
        :reply-announcement="replyAnnouncement"
        :character-name="currentCharacter.name"
        :chat-error="chatError"
        :reminders="pendingReminders"
        :live-dot-state="liveDotState"
        :live-dot-text="liveDotText"
        :speech-capturing="speechState === 'capturing'"
        :speech-auto-listening="speechAutoListening"
        @open-chat="openChatWindow"
        @open-reminder="openReminderRoute"
        @dismiss-reminder="dismissReminder"
      />
      <CompanionOrbitMenu v-if="desktopBridge" :open="petGestures.controlsOpen.value" :character-id="activeChar"
        :character-name="currentCharacter.name" :pinned="alwaysOnTop" :pass-through="ignoreMouseEvents"
        :controls="characterStageRef?.petControls" :set-expression="characterStageRef?.setPetExpression"
        @close="petGestures.controlsOpen.value = false" @settings="settingsOpen = true" @appearance="openAppearance"
        @chat="openChatWindow" @pin="togglePin" @pass="toggleMouseEvents" @hide="desktopBridge.hide"
        @character="switchPetCharacter" @motion="characterStageRef?.playPetMotion?.($event)" />
    </main>
  </article>
</template>

<script setup lang="ts">

import CompanionPreferences from '@/components/CompanionPreferences.vue'
import CompanionOrbitMenu from '@/components/CompanionOrbitMenu.vue'
import CompanionClipboardCard from '@/components/CompanionClipboardCard.vue'
import VoiceGlow from "@/components/visual/VoiceGlow.vue"
import { defineAsyncComponent, ref, watch } from 'vue'
const AppearancePreferences = defineAsyncComponent(() => import('@/components/AppearancePreferences.vue'))
import '@/assets/css/companion.css'
import '@/assets/css/companion-surface.css'
import CompanionCharacterPicker from '@/components/CompanionCharacterPicker.vue'
import CompanionDesktopFloat from '@/components/CompanionDesktopFloat.vue'
import CompanionWorkspaceSettings from '@/components/CompanionWorkspaceSettings.vue'
import ToggleSwitch from '@/components/visual/ToggleSwitch.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import { usePetGestures } from '@/composables/chat/usePetGestures'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { submitChatOnEnter } from '@/utils/chatInput'
const ChatCharacterStage = defineAsyncComponent(() => import('@/components/ChatCharacterStage.vue'))
import Live2DQualityControl from '@/components/Live2DQualityControl.vue'
import SpeechInputSettings from '@/components/SpeechInputSettings.vue'
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
companionCharacters,
switchCharacter,
settingsOpen,
autoVoice,
onAutoVoiceChange,
behaviorEnabled,
dnd,
toggleDnd,
importInputRef,
onImportInputChange,
alwaysOnTop,
togglePin,
ignoreMouseEvents,
toggleMouseEvents,
enterImmersive,
workspaceExists,
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
onSpeechPress,
onSpeechRelease,
onSpeechCancel,
onSpeechLeave,
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
openChatWindow,
liveDotState,
liveDotText
} = useCompanionWorkspace()

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

function reminderActionLabel(reminder: { eventKind?: string }) { return reminder.eventKind === 'sd-done' ? '查看作品册' : '查看服务状态' }
</script>
