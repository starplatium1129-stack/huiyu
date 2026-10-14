<template>
  <article ref="surfaceRef" class="companion-dialogue-window" :data-character="activeChar"
    :data-dock-side="docked ? dockSide : undefined" @keydown.esc="onEscape">
    <section class="companion-dialogue" aria-label="角色对白">
      <header class="companion-dialogue-heading" @mousedown="startWindowDrag">
        <CompanionCharacterPicker :model-value="activeChar" @update:model-value="switchCharacter" />
        <div class="companion-dialogue-controls">
          <StudioTooltip :content="historyOpen ? '回到当前对白' : '回看对话'">
            <button type="button" :aria-label="historyOpen ? '回到当前对白' : '回看对话'"
              :aria-expanded="historyOpen" aria-controls="companion-dialogue-history"
              @click="historyOpen = !historyOpen; speechSettingsOpen = false"><ArchiveIcon name="chat" /></button>
          </StudioTooltip>
          <StudioTooltip content="对白设置">
            <button type="button" aria-label="对白设置" :aria-expanded="speechSettingsOpen"
              aria-controls="companion-dialogue-preferences" @click="speechSettingsOpen = !speechSettingsOpen; historyOpen = false"><ArchiveIcon name="gear" /></button>
          </StudioTooltip>
          <StudioTooltip v-if="bridge?.setChatDocked" :content="docked ? '解除贴靠' : '贴靠桌宠'">
            <button type="button" :disabled="docking" :aria-pressed="docked" :aria-label="docked ? '解除贴靠' : '贴靠桌宠'"
              @click="toggleDock"><ArchiveIcon name="pin" /></button>
          </StudioTooltip>
          <StudioTooltip content="收起对白（Esc）">
            <button type="button" aria-label="收起对白" @click="closeWindow"><ArchiveIcon name="close" /></button>
          </StudioTooltip>
        </div>
      </header>

      <section v-if="speechSettingsOpen" id="companion-dialogue-preferences" class="companion-dialogue-preferences" aria-label="对白设置">
        <div class="companion-dialogue-preference-actions">
          <button type="button" @click="openFullRoom"><ArchiveIcon name="gear" />聊天连接与记忆</button>
          <AppearanceButton />
        </div>
        <Suspense>
          <SpeechInputSettings :data-character="activeChar" @save="onSpeechSettingsSaved" @close="speechSettingsOpen = false" />
          <template #fallback><p role="status">正在读取语音设置…</p></template>
        </Suspense>
      </section>

      <section v-else-if="historyOpen" id="companion-dialogue-history" class="companion-dialogue-history" aria-label="最近对话">
        <div ref="listRef" class="companion-dialogue-history-list" role="log" tabindex="0" aria-label="对话记录">
          <p v-if="!visibleMessages.length" class="companion-dialogue-history-empty">还没有对话。想说什么，直接告诉她吧。</p>
          <div v-for="msg in visibleMessages" :key="msg.mid" class="companion-dialogue-history-message" :data-role="msg.role">
            <div class="companion-dialogue-history-speaker">
              <span>{{ msg.role === 'user' ? '你' : currentCharacter.name }}</span>
              <button v-if="msg.content" type="button" aria-label="复制这条消息" @click="copyMessage(msg.content)"><ArchiveIcon name="copy" /></button>
            </div>
            <p>{{ msg.content || (msg.stopped ? '回复已停止' : '等待回复…') }}</p>
            <small v-if="msg.stopped && msg.content">回复已停止</small>
          </div>
        </div>
        <button v-if="hasNew" class="companion-dialogue-latest" type="button" @click="latest">回到最新消息<ArchiveIcon name="chevron-down" /></button>
      </section>

      <div v-else class="companion-dialogue-current" :aria-busy="replyPending" role="log" aria-label="当前对白" aria-live="off">
        <div v-if="latestUser" class="companion-dialogue-your-line"><span>你</span><p>{{ latestUser.content }}</p></div>
        <p v-if="currentLine" ref="lineRef" class="companion-dialogue-line" :class="{ 'is-streaming': liveState.busy && latestReply }">{{ currentLine }}</p>
        <div v-else-if="replyPending" class="companion-dialogue-waiting" role="status">
          <span class="companion-dialogue-dots" aria-hidden="true"><i></i><i></i><i></i></span>
          <span>{{ liveState.thinking ? '想一想…' : '正在回应你…' }}</span>
        </div>
        <p v-else class="companion-dialogue-unanswered" role="status">{{ latestReply?.stopped ? '回复已停止。' : '这句还没有收到回复。' }}</p>
        <button v-if="hasMoreLine" class="companion-dialogue-latest" type="button" @click="followLine">继续读<ArchiveIcon name="chevron-down" /></button>
        <div v-if="liveState.speaking || latestReply?.stopped || speechSessionActive || quietHint" class="companion-dialogue-presence" role="status">
          <span v-if="liveState.speaking"><ArchiveIcon name="sound" />正在说话</span>
          <span v-else-if="latestReply?.stopped && currentLine">回复已停止</span>
          <span v-if="quietHint"><ArchiveIcon name="moon" />安静时段</span>
          <button v-if="speechSessionActive" type="button" @click="onSpeechSessionEnd">结束连续对话<ArchiveIcon name="close" /></button>
        </div>
        <button v-if="latestReply?.content && !replyPending" class="companion-dialogue-copy" type="button"
          aria-label="复制当前对白" @click="copyMessage(latestReply.content)"><ArchiveIcon name="copy" /></button>
      </div>
    </section>

    <div v-if="!liveState.chatReady" class="companion-dialogue-connection" role="status">
      <span>聊天还未连接</span><button type="button" @click="openFullRoom">连接设置<ArchiveIcon name="chevron-down" /></button>
    </div>
    <CompanionClipboardCard :card="attachments.clipboardCard.value" :character-name="currentCharacter.name"
      @inspect="attachments.inspectClipboardImage" @accept="attachments.acceptClipboardCard" @dismiss="attachments.dismissClipboardCard" />
    <CompanionDrawingDraftCard v-if="drawingDraft" :draft="drawingDraft" />
    <div class="companion-dialogue-composer">
      <StudioTooltip v-if="bridge" content="让角色看当前屏幕（需支持图片的聊天模型）">
        <button class="companion-dialogue-microphone" type="button" aria-label="看屏幕"
          :disabled="!liveState.chatReady || replyPending || attachments.capturingScreen.value" @click="attachments.onCaptureAndInspectScreen"><ArchiveIcon name="eye" /></button>
      </StudioTooltip>
      <StudioTooltip v-if="speechReady" :content="speechError || '按住说话，松开识别'">
        <button class="companion-dialogue-microphone" type="button" :data-state="speechState"
          :aria-label="speechButtonText" :disabled="speechButtonDisabled"
          @pointerdown.prevent="onSpeechPress" @pointerup="onSpeechRelease" @pointercancel="onSpeechCancel" @pointerleave="onSpeechLeave"
          @keydown.space.prevent="!$event.repeat && onSpeechPress()" @keyup.space.prevent="onSpeechRelease"
          @keydown.enter.prevent="!$event.repeat && onSpeechPress()" @keyup.enter.prevent="onSpeechRelease" @blur="onSpeechCancel"><ArchiveIcon name="sound" /></button>
      </StudioTooltip>
      <textarea ref="inputRef" v-model="inputText" rows="1" maxlength="1200" class="companion-dialogue-input"
        :placeholder="`对${currentCharacter.name}说…`" aria-label="桌宠聊天输入"
        @input="onInput" @keydown.enter.exact="submitChatOnEnter($event, onSend)"></textarea>
      <StudioTooltip v-if="replyPending || liveState.speaking || liveState.voiceActive || attachments.capturingScreen.value" content="停止回复或语音">
        <button class="companion-dialogue-send" type="button" aria-label="停止回复或语音" @click="onStop"><ArchiveIcon name="stop" /></button>
      </StudioTooltip>
      <StudioTooltip v-else content="发送 · Enter（Shift+Enter 换行）">
        <button class="companion-dialogue-send" type="button" aria-label="发送" :disabled="!canSend" @click="onSend"><ArchiveIcon name="send" /></button>
      </StudioTooltip>
    </div>
    <p v-if="errorText || liveState.chatError || speechState === 'error' && speechError || noticeText" class="companion-dialogue-feedback"
      :data-error="Boolean(errorText || liveState.chatError || speechState === 'error' && speechError)" role="status">{{ errorText || liveState.chatError || (speechState === 'error' ? speechError : '') || noticeText }}</p>
    <p v-else-if="speechState === 'acquiring' || speechState === 'capturing' || speechState === 'recognizing'"
      class="companion-dialogue-feedback" role="status">{{ speechButtonText }}</p>
    <p class="sr-only" role="status" aria-live="polite">{{ !replyPending ? latestReply?.content : '' }}</p>
  </article>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from 'vue'
import AppearanceButton from '@/components/AppearanceButton.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import CompanionCharacterPicker from '@/components/CompanionCharacterPicker.vue'
import CompanionClipboardCard from '@/components/CompanionClipboardCard.vue'
import { submitChatOnEnter } from '@/utils/chatInput'
import { useCompanionChatWindow } from '@/composables/chat/useCompanionChatWindow'
import { useCompanionDialogueSurface } from '@/composables/chat/useCompanionDialogueSurface'
import { useConversationReading } from '@/composables/chat/useConversationReading'
import '@/assets/css/companion-dialogue.css'

const SpeechInputSettings = defineAsyncComponent(() => import('@/components/SpeechInputSettings.vue'))
const CompanionDrawingDraftCard = defineAsyncComponent(() => import('@/components/CompanionDrawingDraftCard.vue'))
const {
  attachments, activeChar, currentCharacter, bridge, switchCharacter, openFullRoom, closeWindow, startWindowDrag,
  noticeText, quietHint, listRef, visibleMessages, liveState, inputRef, inputText,
  onInput, onSend, speechReady, speechState, speechError, speechButtonDisabled,
  onSpeechPress, onSpeechRelease, onSpeechCancel, onSpeechLeave, speechButtonText, speechSettingsOpen,
  onStop, canSend, sending, errorText, speechSessionActive, onSpeechSessionEnd, onSpeechSettingsSaved,
  hasNew, latest, copyMessage, docked, docking, toggleDock,
} = useCompanionChatWindow()
const historyOpen = ref(false)
const drawingDraft = computed(() => visibleMessages.value.flatMap(message => message.drawingDrafts || []).at(-1))
const { surfaceRef, dockSide } = useCompanionDialogueSurface(Boolean(bridge))
const latestUser = computed(() => [...visibleMessages.value].reverse().find(msg => msg.role === 'user'))
const latestReply = computed(() => {
  const last = visibleMessages.value.at(-1)
  return last?.role === 'assistant' ? last : undefined
})
const replyPending = computed(() => sending.value || liveState.busy || liveState.thinking)
const currentLine = computed(() => latestReply.value?.content || (!visibleMessages.value.length ? currentCharacter.value.greeting : ''))
const lineRef = ref<HTMLElement>()
const { hasNew: hasMoreLine, latest: followLine } = useConversationReading(lineRef, () => currentLine.value, activeChar)
watch(activeChar, () => { historyOpen.value = false; speechSettingsOpen.value = false })
function onEscape(event: KeyboardEvent) {
  if (event.defaultPrevented || document.querySelector('dialog[open]')) return
  event.preventDefault()
  if (speechSettingsOpen.value) speechSettingsOpen.value = false
  else if (historyOpen.value) historyOpen.value = false
  else closeWindow()
}
</script>
