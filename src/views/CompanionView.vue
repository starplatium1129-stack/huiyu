<template>
  <article
    class="companion-page"
    :class="{ 'has-character-picker': companionCharacters.length > 3 }"
    :data-character="activeChar"
    :data-power-mode="desktopBridge ? (onBatteryPower ? 'efficiency' : 'quality') : undefined"
    :data-ui-hidden="uiHidden || undefined"
    :data-presence="presence.kind"
  >
    <div class="companion-ambience" aria-hidden="true">
      <i></i><i></i><i></i>
    </div>
    <header class="companion-toolbar" :data-hidden="immersive ? 'true' : undefined">
      <div class="companion-identity">
        <span>{{ currentCharacter.roomCode }}</span>
        <h1>与{{ currentCharacter.name }}相伴</h1>
        <div
          class="companion-affection-pill"
          :title="`当前好感度 ${affectionScore}/100\n${affectionInfo.title}（Lv.${affectionInfo.level}）: ${affectionInfo.description}`"
        >
          <ArchiveIcon name="love" class="companion-affection-icon" />
          <span class="companion-affection-label">Lv.{{ affectionInfo.level }} {{ affectionInfo.title }}</span>
          <span class="companion-affection-value">{{ affectionScore }}</span>
        </div>
      </div>
      <div class="companion-toolbar-actions">
        <select v-if="companionCharacters.length > 3" class="companion-character-select"
          :value="activeChar" aria-label="切换陪伴角色" @change="switchCharacter(($event.target as HTMLSelectElement).value)">
          <option v-for="character in companionCharacters" :key="character.id" :value="character.id">{{ character.name }}</option>
        </select>
        <div v-else-if="desktopBridge" class="companion-char-switch" aria-label="切换角色">
          <button
            v-for="character in companionCharacters"
            :key="character.id"
            type="button"
            :aria-pressed="activeChar === character.id ? 'true' : 'false'"
            :class="{ active: activeChar === character.id }"
            :title="`切换到${character.name}`"
            @click="switchCharacter(character.id)"
          >{{ character.shortName }}</button>
        </div>
        <button
          type="button"
          class="companion-settings-btn"
          aria-label="设置"
          :aria-expanded="settingsOpen"
          @click="settingsOpen = !settingsOpen"
        ><ArchiveIcon name="gear" /><span>设置</span></button>
        <FluidTransition>
<div v-if="settingsOpen" class="companion-settings-popover" role="dialog" aria-label="桌宠设置" @pointerdown.stop>
          <AppearancePreferences launcher-only @open="settingsOpen = false" />
          <div class="companion-pop-group">
            <strong>陪伴</strong>
            <Live2DQualityControl :native="Boolean(desktopBridge)" />
            <label class="companion-pop-item" title="实时配音">
              <input type="checkbox" v-model="autoVoice" @change="onAutoVoiceChange" />
              <span title="播放聊天回复和新问候；勿扰时暂停主动问候">实时配音：{{ autoVoice ? '开' : '关' }}</span>
            </label>
            <button v-if="behaviorEnabled" type="button" class="companion-pop-item" :aria-pressed="dnd" @click="toggleDnd">
              {{ dnd ? '关闭勿扰（恢复主动问候）' : '开启勿扰（暂停主动问候）' }}
            </button>
            <button type="button" class="companion-pop-item" @click="importInputRef?.click()">导入图片到作品册</button>
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
          <div v-if="desktopBridge" class="companion-pop-group">
            <strong>窗口</strong>
            <button type="button" class="companion-pop-item" :aria-pressed="alwaysOnTop" @click="togglePin">
              {{ alwaysOnTop ? '取消置顶' : '置顶窗口' }}
            </button>
            <button
              type="button"
              class="companion-pop-item"
              :title="ignoreMouseEvents ? '恢复窗口交互（Ctrl+Shift+P）' : '开启鼠标穿透（Ctrl+Shift+P）'"
              :aria-pressed="ignoreMouseEvents"
              @click="toggleMouseEvents"
            >{{ ignoreMouseEvents ? '恢复窗口交互' : '鼠标穿透' }}</button>
            <button type="button" class="companion-pop-item" title="隐藏 Companion（Ctrl+Shift+Space）" @click="desktopBridge.hide">隐藏 Companion</button>
            <button type="button" class="companion-pop-item" title="沉浸模式：只保留角色与对话（Esc 退出）" @click="enterImmersive">沉浸模式</button>
          </div>
          <div class="companion-pop-group">
            <strong>工作台</strong>
            <button type="button" class="companion-pop-item" title="打开完整工作台（Ctrl+Shift+A）" @click="desktopBridge ? desktopBridge.openAtelier() : $router.push('/prompt-builder')">打开完整工作台</button>
            <button v-if="desktopBridge" type="button" class="companion-pop-item" @click="desktopBridge.openAtelier('/chat')">完整房间（聊天）</button>
            <RouterLink v-else class="companion-pop-item" to="/chat">完整房间（聊天）</RouterLink>
          </div>
          <div v-if="desktopBridge" class="companion-pop-group">
            <strong>诊断</strong>
            <span
              class="companion-pop-item"
              :title="onBatteryPower ? '检测到电池供电，Live2D 自动降至 30 FPS' : '接电运行，Native Live2D 目标 165 FPS'"
            >{{ onBatteryPower ? 'Live2D 30 FPS（电池）' : 'Live2D 165 FPS（接电）' }}</span>
            <button
              type="button"
              class="companion-pop-item"
              :data-state="workspaceExists ? 'ok' : 'missing'"
              :title="workspaceTooltip"
              @click="workspaceOpen = !workspaceOpen"
            >
              <ArchiveIcon :name="workspaceExists ? 'success' : 'error'" />
              <span>{{ workspaceExists ? 'AI 工作区已就绪' : 'AI 工作区缺失' }}</span>
            </button>
            <label class="companion-pop-item" title="音量">
              <span>音量</span>
              <input
                type="range"
                v-model.number="volume"
                min="0"
                max="100"
                aria-label="桌宠音量"
                @input="onVolumeChange"
              />
            </label>
          </div>
        </div>
</FluidTransition>
      </div>
    </header>

    <main class="companion-stage" aria-label="桌面陪伴模式" :data-immersive="immersive ? 'true' : undefined">
      <button
        v-if="desktopBridge && immersive"
        class="companion-exit-immersive"
        type="button"
        title="退出沉浸模式（Esc）"
        @click="exitImmersive"
      >退出沉浸</button>
      <ChatCharacterStage
        ref="characterStageRef"
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
            :title="reminder.kind === 'event' && reminder.eventKind ? (desktopBridge ? '点击打开对应页面' : '') : ''"
            :class="{ 'companion-reminder-link': reminder.kind === 'event' && reminder.eventKind }"
            @click="openReminderRoute(reminder)"
          >
            <span class="companion-reminder-name">{{ currentCharacter.name }}</span>
            <p>{{ reminder.line }}</p>
            <button type="button" aria-label="关闭这条问候" @click.stop="dismissReminder(reminder.id)">×</button>
          </div>
        </TransitionGroup>
        <Transition name="layer-fade">
        <div v-if="clipboardCard" class="companion-clipboard-card" role="status" aria-live="polite">
          <img v-if="clipboardCard.kind === 'image'" :src="clipboardCard.previewUrl" alt="" />
          <div>
            <strong>{{ clipboardCard.kind === 'image' ? '检测到复制的图片' : '检测到复制的文本' }}</strong>
            <p v-if="clipboardCard.kind === 'text'" class="companion-clipboard-preview">{{ clipboardCard.text }}</p>
          </div>
          <div class="companion-clipboard-actions">
            <button
              v-if="clipboardCard.kind === 'image'"
              type="button"
              class="btn btn-secondary btn-sm"
              @click="inspectClipboardImage"
            >让{{ currentCharacter.name }}看看</button>
            <button type="button" class="btn btn-primary btn-sm" @click="acceptClipboardCard">{{ clipboardCard.kind === 'image' ? '存入作品册' : `发给${currentCharacter.name}` }}</button>
            <button type="button" class="btn btn-ghost btn-sm" @click="dismissClipboardCard">忽略</button>
          </div>
        </div>
        </Transition>
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

        <div v-if="toolActivity || thinkingActivity" class="companion-tool-indicator" role="status">
          <ArchiveIcon :name="toolActivity ? 'gear' : 'spark'" /> {{ toolActivity || '思考中…' }}
        </div>

        <div class="companion-composer">
          <div
            v-if="!chatReady || voiceCapabilityState === 'offline' || preparingRoom"
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
          <button
            class="companion-vision-btn"
            type="button"
            :disabled="busy || !chatReady || capturingScreen"
            :title="`让${currentCharacter.name}看你当前的屏幕画面`"
            aria-label="看屏幕"
            @click="onCaptureAndInspectScreen"
          >
            <ArchiveIcon name="eye" />
            <span>{{ capturingScreen ? '看屏中…' : '看屏幕' }}</span>
          </button>
          <button
            v-if="busy || voiceActive"
            class="companion-stop"
            type="button"
            @click="stopEverything"
          >停止</button>
           <button
             class="companion-send"
             type="button"
             :disabled="busy || !chatReady"
             @click="handleSend"
           >{{ busy ? '回复中' : '发送' }}</button>
           <div v-if="speechReady" class="companion-speech-cluster">
            <button
              class="companion-speech-btn"
              type="button"
              :data-state="speechState"
              :disabled="speechButtonDisabled"
              :title="speechError || '按住说话，松开识别；也可按住 Space'"
              @pointerdown.prevent="onSpeechPress"
              @pointerup="onSpeechRelease"
              @pointercancel="onSpeechCancel"
              @pointerleave="onSpeechLeave"
            >{{ speechButtonText }}</button>
            <span class="companion-speech-state" role="status" aria-live="polite">
              {{ speechStateText || (speechAutoListening ? '听候唤醒' : '') }}
            </span>
             <span v-if="speechSessionActive" class="companion-speech-session" role="status">
               连续对话中
               <button
                 class="companion-speech-session-end"
                 type="button"
                 title="结束连续对话"
                 aria-label="结束连续对话"
                 @click="onSpeechSessionEnd"
               >×</button>
             </span>
            <button
              class="companion-speech-settings"
              type="button"
              title="语音输入设置"
              aria-label="语音输入设置"
              @click="speechSettingsOpen = !speechSettingsOpen"
            >设置</button>
           </div>
           <div v-else class="companion-speech-cluster">
             <button
               class="companion-speech-settings"
               type="button"
               title="配置语音输入"
               aria-label="配置语音输入"
               @click="speechSettingsOpen = true"
             >语音设置</button>
           </div>
           <div class="companion-composer-meta" aria-live="polite">
             <span class="companion-chat-status">{{ chatStatusText }}</span>
             <span v-if="voiceStatusText" class="companion-voice-status">{{ voiceStatusText }}</span>
             <span v-if="inQuietHours" class="companion-quiet-hours-hint" :title="quietHoursText"><ArchiveIcon name="moon" /> 安静时段</span>
           </div>
         </div>

        <SpeechInputSettings
          v-if="speechSettingsOpen"
          @save="onSpeechSettingsSaved"
          @close="speechSettingsOpen = false"
        />

        <div class="companion-error" role="status" aria-live="polite" :data-kind="chatErrorKind">
          {{ chatError }}
        </div>
        <p class="sr-only" role="status" aria-live="polite">{{ replyAnnouncement }}</p>
      </section>

      <FluidTransition>
<div v-if="workspaceOpen" class="companion-workspace-settings" role="dialog" aria-label="AI 工作区设置">
        <div>
          <strong>AI 工作区</strong>
          <span>存放样张、训练数据与配音资源的目录（例如 E:\AI）。设置后网关重启生效。</span>
        </div>
        <input
          v-model="workspaceInput"
          type="text"
          placeholder="目录路径"
          aria-label="AI 工作区目录路径"
          @keydown.enter="saveWorkspace"
        />
        <div class="companion-workspace-actions">
          <button type="button" class="btn btn-primary" :disabled="workspaceSaving" @click="saveWorkspace">
            {{ workspaceSaving ? '保存中…' : '保存并重启网关' }}
          </button>
          <button type="button" class="btn btn-ghost" @click="workspaceOpen = false">关闭</button>
        </div>
      </div>
</FluidTransition>

      <!-- 真双窗口（桌面）浮层：角色为主，聊天独立窗口。 -->
      <div v-if="desktopBridge" class="companion-desktop-float" aria-label="桌宠快捷操作">
        <TransitionGroup name="reminder-pop" tag="div" class="companion-float-reminders" role="log" aria-label="角色主动问候">
          <div
            v-for="reminder in pendingReminders"
            :key="reminder.id"
            class="companion-float-reminder"
            :data-kind="reminder.kind"
            :data-event-kind="reminder.eventKind || undefined"
            :title="reminder.kind === 'event' && reminder.eventKind ? '点击打开对应页面' : ''"
            :class="{ 'companion-reminder-link': reminder.kind === 'event' && reminder.eventKind }"
            @click="openReminderRoute(reminder)"
          >
            <span>{{ currentCharacter.name }}</span>
            <p>{{ reminder.line }}</p>
            <button type="button" aria-label="关闭这条问候" @click.stop="dismissReminder(reminder.id)">×</button>
          </div>
        </TransitionGroup>
        <button
          class="companion-chat-chip"
          type="button"
          title="打开聊天窗（Ctrl+Shift+X）"
          aria-label="打开聊天"
          @click="openChatWindow"
        ><ArchiveIcon name="chat" /><span>聊天</span></button>
        <span class="companion-live-dot" :data-state="liveDotState" role="status" aria-live="polite">
          <i aria-hidden="true"></i>{{ liveDotText }}
        </span>
      </div>
    </main>
  </article>
</template>

<script setup lang="ts">
import FluidTransition from "@/components/visual/FluidTransition.vue"
import AppearancePreferences from '@/components/AppearancePreferences.vue'
import '@/assets/css/companion.css'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { submitChatOnEnter } from '@/utils/chatInput'
import ChatCharacterStage from '@/components/ChatCharacterStage.vue'
import Live2DQualityControl from '@/components/Live2DQualityControl.vue'
import SpeechInputSettings from '@/components/SpeechInputSettings.vue'
import { useCompanionWorkspace } from "@/composables/chat/useCompanionWorkspace"
const {
chatListRef,characterStageRef,activeChar,
desktopBridge,
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
</script>

<style scoped>
.companion-character-select { min-width: 0; max-width: 128px; min-height: 32px; padding: 4px 8px; border: 1px solid var(--companion-edge); border-radius: var(--r-md); background: var(--bg-surface); color: var(--text-primary); font: inherit; }
.has-character-picker :deep(.character-tabs) { display: none; }
.companion-page :deep(.local-model-stage .live2d-host) { inset: 96px 0 176px; }
</style>
