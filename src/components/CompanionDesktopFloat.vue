<template>
  <div class="companion-desktop-float">
    <CompanionReplyBubble :text="replyAnnouncement" :name="characterName" @open="emit('open-chat')" />
    <p v-if="chatError" class="companion-float-error" role="alert">{{ chatError }}</p>
    <span v-if="speechCapturing" class="companion-mic-status" role="status">正在聆听</span>
  </div>
</template>

<script setup lang="ts">
import CompanionReplyBubble from '@/components/CompanionReplyBubble.vue'

defineProps<{
  replyAnnouncement: string
  characterName: string
  chatError: string
  speechCapturing: boolean
}>()

const emit = defineEmits<{
  (event: 'open-chat'): void
}>()
</script>
