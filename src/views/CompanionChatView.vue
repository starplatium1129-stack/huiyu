<template>
  <article class="companion-chat-window companion-chat-redesign" :data-character="activeChar">
    <a class="skip-link" href="#companion-chat-main">跳到主要内容</a>
    <header class="desktop-titlebar companion-chat-titlebar" @mousedown="startWindowDrag">
      <div class="companion-chat-identity">
        <ArchiveIcon name="chat" class="companion-chat-brand-icon" />
        <CompanionCharacterPicker :model-value="activeChar" @update:model-value="switchCharacter" />
        <h1 class="sr-only companion-chat-title">与{{ currentCharacter.name }}聊天</h1>
      </div>
      <StudioTooltip content="拖动聊天窗会解除贴靠">
        <span class="companion-chat-drag" tabindex="0">拖动</span>
      </StudioTooltip>
      <div class="titlebar-controls">
        <AppearanceButton class="companion-chat-mini" />
        <StudioTooltip v-if="bridge?.setChatDocked" :content="docked ? '解除贴靠' : '贴靠桌宠'">
          <button class="companion-chat-mini" type="button" :aria-pressed="docked" :aria-label="docked ? '解除贴靠' : '贴靠桌宠'" @click="toggleDock"><ArchiveIcon name="pin" /></button>
        </StudioTooltip>
        <StudioTooltip content="打开完整房间（Chat）">
          <button
            class="companion-chat-mini"
            type="button"
            aria-label="打开完整房间"
            @click="openFullRoom"
          ><ArchiveIcon name="chat" /></button>
        </StudioTooltip>
        <StudioTooltip content="关闭聊天窗">
          <button
            class="companion-chat-mini"
            type="button"
            aria-label="关闭聊天窗"
            @click="closeWindow"
          ><ArchiveIcon name="close" /></button>
        </StudioTooltip>
      </div>
    </header>

    <main id="companion-chat-main" tabindex="-1" class="companion-chat-body" aria-label="桌宠聊天">
      <div class="companion-chat-statusline" role="status" aria-live="polite">
        <i class="companion-chat-status-dot" :data-state="statusDotState" aria-hidden="true"></i>
        <span>{{ statusText }}</span>
        <span v-if="noticeText" class="companion-chat-notice">{{ noticeText }}</span>
        <StudioTooltip v-if="quietHint" content="安静时段静默">
          <span class="companion-chat-quiet">
            <ArchiveIcon name="moon" /> 安静时段
          </span>
        </StudioTooltip>
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
            <button type="button" class="companion-message-copy" @click="copyMessage(msg.content)">复制</button>
            <small v-if="index === visibleMessages.length - 1 && liveState.speaking">配音中…</small>
          </div>
          <div v-if="liveState.busy || liveState.thinking" class="companion-chat-typing" role="status">
            <i></i><i></i><i></i>
            <span>{{ liveState.speaking ? '正在配音' : '正在回复' }}</span>
          </div>
        </template>
      </div>
      <button v-if="hasNew" type="button" class="btn btn-ghost companion-back-latest" @click="latest">回到最新消息</button>

      <div class="companion-chat-composer">
        <div
          v-if="!liveState.chatReady"
          class="companion-chat-setup"
          :data-state="liveState.chatReady === false ? 'warning' : 'normal'"
        >
          <ArchiveIcon name="gear" />
          <span>聊天还未连接，请到完整房间设置。</span>
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
          <StudioTooltip v-if="speechReady" anchor :content="speechError || '按住说话，松开识别；也可按住 Space'">
            <button
              class="companion-chat-speech"
              type="button"
              :data-state="speechState"
              :disabled="speechButtonDisabled"
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
          </StudioTooltip>
          <StudioTooltip v-else content="配置语音输入">
            <button
              class="companion-chat-speech companion-chat-speech-config"
              type="button"
              @click="speechSettingsOpen = true"
            ><ArchiveIcon name="sound" /><span>语音设置</span></button>
          </StudioTooltip>
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
    </main>

    <SpeechInputSettings
      v-if="speechSettingsOpen"
      @save="onSpeechSettingsSaved"
      @close="speechSettingsOpen = false"
    />
  </article>
</template>

<script setup lang="ts">
import AppearanceButton from '@/components/AppearanceButton.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import CompanionCharacterPicker from '@/components/CompanionCharacterPicker.vue'
import SpeechInputSettings from '@/components/SpeechInputSettings.vue'
import { submitChatOnEnter } from '@/utils/chatInput'
import { useCompanionChatWindow } from '@/composables/chat/useCompanionChatWindow'
import '@/assets/css/companion.css'
import '@/assets/css/companion-surface.css'
const { activeChar, currentCharacter, bridge, switchCharacter, openFullRoom, closeWindow, startWindowDrag, statusDotState, statusText, noticeText, quietHint, listRef, visibleMessages, liveState, inputRef, inputText, composerFocused, onInput, onSend, speechReady, speechState, speechError, speechButtonDisabled, onSpeechPress, onSpeechRelease, onSpeechCancel, onSpeechLeave, speechButtonText, speechSettingsOpen, onStop, canSend, sending, errorText, speechSessionActive, metaText, onSpeechSessionEnd, onSpeechSettingsSaved, hasNew, latest, copyMessage, docked, toggleDock } = useCompanionChatWindow()
</script>
