<template>
  <article ref="surfaceRef" class="companion-dialogue-window" :data-character="activeChar" :data-desktop="Boolean(bridge) || undefined"
    :data-dock-side="docked ? dockSide : undefined" @keydown.esc="onEscape"
    @dragover.prevent @drop="attachments.onImageDrop" @paste="attachments.onImagePaste">
    <section class="companion-dialogue" aria-label="角色对白">
      <header class="companion-dialogue-heading" @mousedown="startWindowDrag">
        <CompanionCharacterPicker :model-value="activeChar" @update:model-value="switchCharacter" />
        <div class="companion-dialogue-controls">
          <StudioTooltip :content="historyOpen ? '回到最近消息' : '回看对话'">
            <button type="button" :aria-label="historyOpen ? '回到最近消息' : '回看对话'"
              :aria-expanded="historyOpen" aria-controls="companion-dialogue-history"
              @click="historyOpen = !historyOpen; speechSettingsOpen = false"><ArchiveIcon name="chat" /></button>
          </StudioTooltip>
          <StudioTooltip content="对白设置">
            <button ref="speechSettingsTrigger" type="button" aria-label="对白设置" :aria-expanded="speechSettingsOpen"
              aria-controls="companion-dialogue-preferences" @click="speechSettingsOpen = !speechSettingsOpen; historyOpen = false"><ArchiveIcon name="gear" /></button>
          </StudioTooltip>
          <StudioTooltip v-if="bridge?.setChatDocked" anchor :content="docking ? '正在调整贴靠…' : docked ? '解除贴靠' : '贴靠桌宠'">
            <button type="button" :disabled="docking" :aria-pressed="docked" :aria-label="docked ? '解除贴靠' : '贴靠桌宠'"
              @click="toggleDock"><ArchiveIcon name="pin" /></button>
          </StudioTooltip>
          <StudioTooltip content="收起对白（Esc）">
            <button type="button" aria-label="收起对白" @click="closeWindow"><ArchiveIcon name="close" /></button>
          </StudioTooltip>
        </div>
      </header>

      <section v-if="speechSettingsOpen" ref="speechSettingsPanel" tabindex="-1" id="companion-dialogue-preferences" class="companion-dialogue-preferences" aria-label="对白设置">
        <div class="companion-dialogue-preference-actions">
          <button type="button" @click="openFullRoom"><ArchiveIcon name="gear" />聊天连接与记忆</button>
          <AppearanceButton compact />
        </div>
        <Suspense>
          <SpeechInputSettings :data-character="activeChar" @save="onSpeechSettingsSaved" @close="speechSettingsOpen = false" />
          <template #fallback><p role="status">正在读取语音设置…</p></template>
        </Suspense>
      </section>

      <section v-else id="companion-dialogue-history" class="companion-dialogue-history" aria-label="最近对话">
        <div ref="listRef" class="companion-dialogue-history-list" :aria-busy="replyPending" role="log" tabindex="0" aria-label="对话记录" aria-live="off">
          <div v-if="!displayedMessages.length" class="companion-dialogue-message" data-role="assistant">
            <div class="companion-dialogue-avatar" :data-chibi="Boolean(chibiAvatars[activeChar]) || undefined" aria-hidden="true"><RuntimeImage :src="avatar" alt=""><template #fallback>{{ currentCharacter.name.slice(0, 1) }}</template></RuntimeImage></div>
            <div class="companion-dialogue-bubble"><p class="companion-dialogue-line">{{ currentCharacter.greeting }}</p></div>
          </div>
          <div v-for="msg in displayedMessages" :key="msg.mid" class="companion-dialogue-message" :data-role="msg.role">
            <div v-if="msg.role === 'assistant'" class="companion-dialogue-avatar" :data-chibi="Boolean(chibiAvatars[activeChar]) || undefined" aria-hidden="true"><RuntimeImage :src="avatar" alt=""><template #fallback>{{ currentCharacter.name.slice(0, 1) }}</template></RuntimeImage></div>
            <div class="companion-dialogue-bubble">
              <div class="companion-dialogue-speaker">
                <span>{{ msg.role === 'user' ? '你' : currentCharacter.name }}</span>
                <button v-if="msg.content" type="button" aria-label="复制这条消息" @click="copyMessage(msg.content)"><ArchiveIcon name="copy" /></button>
              </div>
              <p v-if="msg.content" class="companion-dialogue-line" :class="{ 'is-streaming': liveState.busy && msg.mid === latestReply?.mid }"><ChatMessageText :text="msg.content" /></p>
              <CompanionChatImages v-if="msg.images?.length" :images="msg.images" />
              <CompanionDrawingDraftCard v-for="drawing in msg.drawingDrafts || []" :key="drawing.path" :draft="drawing" />
              <div v-if="!msg.content && msg.mid === latestReply?.mid && replyPending" class="companion-dialogue-waiting" role="status">
                <span class="companion-dialogue-dots" aria-hidden="true"><i></i><i></i><i></i></span>
                <span>{{ liveState.toolActivity || (liveState.thinking ? '想一想…' : '正在回应你…') }}</span>
              </div>
              <small v-if="msg.stopped">回复已停止</small>
            </div>
          </div>
        </div>
        <button v-if="hasNew" class="companion-dialogue-latest" type="button" @click="latest">回到最新消息<ArchiveIcon name="chevron-down" /></button>
        <div v-if="liveState.speaking || speechSessionActive || quietHint" class="companion-dialogue-presence" role="status">
          <span v-if="liveState.speaking"><ArchiveIcon name="sound" />正在说话</span>
          <span v-if="quietHint"><ArchiveIcon name="moon" />安静时段</span>
          <button v-if="speechSessionActive" type="button" @click="onSpeechSessionEnd">结束连续对话<ArchiveIcon name="close" /></button>
        </div>
      </section>
    </section>

    <div v-if="!liveState.chatReady" class="companion-dialogue-connection" role="status">
      <span>聊天还未连接</span><button type="button" @click="openFullRoom">连接设置<ArchiveIcon name="chevron-down" /></button>
    </div>
    <section v-if="selectedImage" class="companion-dialogue-attachment" aria-label="待发送的图片">
      <img :src="selectedImage.previewUrl" :alt="`待发送：${selectedImage.name}`" />
      <div><strong>{{ selectedImage.name }}</strong></div>
      <button type="button" aria-label="移除待发送的图片" @click="attachments.cancelImageInput"><ArchiveIcon name="close" /></button>
      <button class="companion-dialogue-image-generate" type="button" :disabled="!attachments.canGenerateImage.value"
        @click="attachments.sendPendingImage('generate-from-image')"><ArchiveIcon name="palette" />反推并生成</button>
    </section>
    <input ref="imageInputRef" class="sr-only" type="file" tabindex="-1" aria-hidden="true" accept="image/png,image/jpeg,image/webp" @change="attachments.onImageInputChange" />
    <div class="companion-dialogue-composer">
      <StudioTooltip v-if="bridge" anchor :content="attachments.preparingImage.value ? '正在准备图片…' : '发送图片，也可粘贴或拖入图片'">
        <button class="companion-dialogue-microphone" type="button" aria-label="添加图片" :disabled="attachments.preparingImage.value"
          @click="attachments.pickImage"><ArchiveIcon name="image" /></button>
      </StudioTooltip>
      <StudioTooltip v-if="bridge" anchor :content="!liveState.chatReady ? '请先连接聊天模型' : replyPending || attachments.sendingImage.value ? '请等待当前回复或图片发送完成' : '让角色看当前屏幕（需支持图片的聊天模型）'">
        <button class="companion-dialogue-microphone" type="button" aria-label="看屏幕"
          :disabled="!liveState.chatReady || replyPending || attachments.sendingImage.value" @click="attachments.onCaptureAndInspectScreen"><ArchiveIcon name="eye" /></button>
      </StudioTooltip>
      <StudioTooltip v-if="speechReady" anchor :content="speechError || (replyPending ? '请等待当前回复完成' : speechSettingsOpen ? '关闭对白设置后可按住说话' : speechButtonText)">
        <button class="companion-dialogue-microphone" type="button" :data-state="speechState"
          :aria-label="speechButtonText" :disabled="speechButtonDisabled"
          @pointerdown.prevent="onSpeechPress" @pointerup="onSpeechRelease" @pointercancel="onSpeechCancel" @pointerleave="onSpeechLeave"
          @keydown.space.prevent="!$event.repeat && onSpeechPress()" @keyup.space.prevent="onSpeechRelease"
          @keydown.enter.prevent="!$event.repeat && onSpeechPress()" @keyup.enter.prevent="onSpeechRelease" @blur="onSpeechCancel"><ArchiveIcon name="sound" /></button>
      </StudioTooltip>
      <textarea ref="inputRef" v-model="inputText" rows="1" maxlength="1200" class="companion-dialogue-input"
        :placeholder="`对${currentCharacter.name}说…`" aria-label="桌宠聊天输入"
        @input="onInput" @keydown.enter.exact="submitChatOnEnter($event, sendChat)"></textarea>
      <StudioTooltip v-if="replyPending || liveState.speaking || liveState.voiceActive || attachments.sendingImage.value" content="停止回复或语音">
        <button class="companion-dialogue-send" type="button" aria-label="停止回复或语音" @click="onStop"><ArchiveIcon name="stop" /></button>
      </StudioTooltip>
      <StudioTooltip v-else anchor :content="!bridge ? '请在桌面客户端中发送消息' : !liveState.chatReady ? '请先连接聊天模型' : selectedImage ? '发送图片' : !inputText.trim() ? '先写一条消息' : '发送 · Enter（Shift+Enter 换行）'">
        <button class="companion-dialogue-send" type="button" aria-label="发送" :disabled="selectedImage ? !attachments.canSendImage.value : !canSend" @click="sendChat"><ArchiveIcon name="send" /></button>
      </StudioTooltip>
    </div>
    <p v-if="liveState.toolActivity" class="companion-dialogue-feedback" role="status">{{ liveState.toolActivity }}</p>
    <p v-if="errorText || liveState.chatError || speechState === 'error' && speechError || noticeText" class="companion-dialogue-feedback"
      :data-error="Boolean(errorText || liveState.chatError || speechState === 'error' && speechError)" role="status">{{ errorText || liveState.chatError || (speechState === 'error' ? speechError : '') || noticeText }}</p>
    <p v-else-if="speechState === 'acquiring' || speechState === 'capturing' || speechState === 'recognizing'"
      class="companion-dialogue-feedback" role="status">{{ speechButtonText }}</p>
    <p v-else-if="attachments.preparingImage.value" class="companion-dialogue-feedback" role="status">正在准备图片…</p>
    <p class="sr-only" role="status" aria-live="polite">{{ !replyPending ? latestReply?.content : '' }}</p>
  </article>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, ref, watch } from 'vue'
import AppearanceButton from '@/components/AppearanceButton.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import RuntimeImage from '@/components/visual/RuntimeImage.vue'
import ChatMessageText from '@/components/ChatMessageText.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import CompanionCharacterPicker from '@/components/CompanionCharacterPicker.vue'
import { submitChatOnEnter } from '@/utils/chatInput'
import { useCompanionChatWindow } from '@/composables/chat/useCompanionChatWindow'
import { useCompanionDialogueSurface } from '@/composables/chat/useCompanionDialogueSurface'
import { useInlinePanelFocus } from '@/composables/chat/useInlinePanelFocus'
import { characterArtEntry } from '@/platform/characterArtState'
import { resolveCompanionAvatar } from '@/utils/companionRegistry'
import { companionChatAvatars as chibiAvatars } from '@/config/companionChatAvatars'
import '@/assets/css/companion-dialogue.css'

const SpeechInputSettings = defineAsyncComponent(() => import('@/components/SpeechInputSettings.vue'))
const CompanionChatImages = defineAsyncComponent(() => import('@/components/CompanionChatImages.vue'))
const CompanionDrawingDraftCard = defineAsyncComponent(() => import('@/components/CompanionDrawingDraftCard.vue'))
const {
  attachments, activeChar, currentCharacter, bridge, switchCharacter, openFullRoom, closeWindow, startWindowDrag,
  noticeText, quietHint, listRef, visibleMessages, liveState, inputRef, inputText,
  onInput, onSend, speechReady, speechState, speechError, speechButtonDisabled,
  onSpeechPress, onSpeechRelease, onSpeechCancel, onSpeechLeave, speechButtonText, speechSettingsOpen,
  onStop, canSend, sending, errorText, speechSessionActive, onSpeechSessionEnd, onSpeechSettingsSaved,
  hasNew, latest, copyMessage, docked, docking, toggleDock,
} = useCompanionChatWindow()
const selectedImage = attachments.selectedImage, imageInputRef = attachments.imageInputRef
function sendChat() {
  if (selectedImage.value) void attachments.sendPendingImage()
  else onSend()
}
const historyOpen = ref(false)
const speechSettingsTrigger = ref<HTMLElement | null>(null), speechSettingsPanel = ref<HTMLElement | null>(null)
useInlinePanelFocus(speechSettingsOpen, () => speechSettingsPanel.value, speechSettingsTrigger)
const { surfaceRef, dockSide } = useCompanionDialogueSurface(Boolean(bridge))
const displayedMessages = computed(() => historyOpen.value ? visibleMessages.value : visibleMessages.value.slice(-12))
const avatar = computed(() => chibiAvatars[activeChar.value] || characterArtEntry(activeChar.value)?.thumbnailUrl || resolveCompanionAvatar(activeChar.value)?.avatar.thumbnailUrl || currentCharacter.value.image)
const latestReply = computed(() => {
  const last = visibleMessages.value.at(-1)
  return last?.role === 'assistant' ? last : undefined
})
const replyPending = computed(() => sending.value || liveState.busy || liveState.thinking)
watch(historyOpen, async open => {
  await nextTick()
  if (open && listRef.value) listRef.value.scrollTop = 0
  else void latest()
})
watch(activeChar, () => { historyOpen.value = false; speechSettingsOpen.value = false })
function onEscape(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || document.querySelector('dialog[open]')) return
  event.preventDefault()
  if (speechSettingsOpen.value) speechSettingsOpen.value = false
  else if (historyOpen.value) historyOpen.value = false
  else closeWindow()
}
</script>
