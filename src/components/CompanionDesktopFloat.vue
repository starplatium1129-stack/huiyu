<template>
  <div class="companion-desktop-float">
    <CompanionReplyBubble :text="replyAnnouncement" :name="characterName" @open="emit('open-chat')" />
    <div v-if="chatError" class="companion-float-error" role="alert">{{ chatError }}</div>
    <TransitionGroup name="reminder-pop" tag="div" class="companion-float-reminders" role="log" aria-label="角色主动问候">
      <div
        v-for="reminder in reminders"
        :key="reminder.id"
        class="companion-float-reminder"
        :data-kind="reminder.kind"
        :data-event-kind="reminder.eventKind || undefined"
        :class="{ 'companion-reminder-link': reminder.kind === 'event' && reminder.eventKind }"
      >
        <span>{{ characterName }}</span>
        <p>{{ reminder.line }}</p>
        <div v-if="reminder.kind === 'event' && reminder.eventKind" class="companion-reminder-actions">
          <button type="button" class="companion-reminder-action" @click="emit('open-reminder', reminder)">{{ reminderActionLabel(reminder) }}</button>
        </div>
        <button type="button" class="companion-reminder-dismiss" aria-label="关闭这条问候" @click="emit('dismiss-reminder', reminder.id)"><ArchiveIcon name="close" /></button>
      </div>
    </TransitionGroup>
    <div class="companion-action-dock" role="group" aria-label="桌宠快捷操作">
      <StudioTooltip v-if="showWatch && showChat" content="打开对白窗（Ctrl+Shift+X）">
        <button type="button" class="btn btn-quiet btn-sm companion-dock-action" aria-label="打开对白" @click="emit('open-chat')">
          <ArchiveIcon name="chat" /><span>对白</span>
        </button>
      </StudioTooltip>
      <slot v-if="showWatch" name="watch" />
      <slot name="import-recovery" />
    </div>
    <span class="companion-live-dot" :data-state="liveDotState" role="status" aria-live="polite">
      <i aria-hidden="true"></i>{{ liveDotText }}
    </span>
    <span v-if="speechCapturing || speechAutoListening" class="companion-mic-status" role="status">{{ speechCapturing ? '正在聆听' : '听候唤醒' }}</span>
  </div>
</template>

<script setup lang="ts">
import type { CompanionReminder } from '@/utils/companionBehavior'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import CompanionReplyBubble from '@/components/CompanionReplyBubble.vue'

defineProps<{
  replyAnnouncement: string
  characterName: string
  chatError: string
  reminders: CompanionReminder[]
  liveDotState: string
  liveDotText: string
  speechCapturing: boolean
  speechAutoListening: boolean
  showWatch: boolean
  showChat: boolean
}>()

const emit = defineEmits<{
  (event: 'open-chat'): void
  (event: 'open-reminder', reminder: CompanionReminder): void
  (event: 'dismiss-reminder', id: string): void
}>()

function reminderActionLabel(reminder: CompanionReminder): string {
  return reminder.eventKind === 'image-ready' ? '打开任务中心' : '查看控制面板'
}
</script>
