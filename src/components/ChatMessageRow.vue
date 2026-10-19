<template>
  <div class="message" :class="[message.role, { streaming, speaking: playing }]" :data-mid="message.mid">
    <div v-if="message.role === 'assistant'" class="message-avatar" :data-chibi="chibi || undefined" aria-hidden="true">
      <RuntimeImage :src="avatar" alt=""><template #fallback><ArchiveIcon name="character" /></template></RuntimeImage>
    </div>
    <div class="message-body">
      <div class="message-bubble" v-content-motion:fade="message.mid">
        <ChatMessageText v-if="message.content" :text="message.content" />
        <CompanionChatImages v-if="message.images?.length" :images="message.images" />
        <CompanionDrawingDraftCard v-for="drawing in message.drawingDrafts || []" :key="drawing.path" :draft="drawing" />
        <span v-if="!message.content && streaming" class="room-message-waiting">正在回复…</span>
      </div>
      <span v-if="message.stopped || playing" class="message-note">{{ message.stopped ? '已停止' : '播放中' }}</span>
      <ChatReplyVariants v-if="message.variants?.length" :message="message" :disabled="storyDisabled" @select="emit('select-variant', $event)" />
    </div>
    <ChatMessageActions :can-copy="Boolean(message.content)" :can-remember="message.role === 'user' && Boolean(message.mid)"
      :remembered="remembered" :can-play="message.role === 'assistant' && Boolean(message.mid && hasAudio(message.mid))"
      :playing="playing" :memories="message.recalledMemories"
      :can-regenerate="canRegenerate" :reply-missing="message.role === 'user'" :can-fork="Boolean(message.content)" :story-disabled="storyDisabled"
      @copy="emit('copy', message.content)" @remember="emit('remember', message)" @play="message.mid && emit('play', message.mid)"
      @regenerate="emit('regenerate')" @fork="emit('fork')" />
  </div>
</template>

<script lang="ts">
import { defineAsyncComponent } from 'vue'

// Share resolved attachment components across message rows and room visits.
const CompanionDrawingDraftCard = defineAsyncComponent(() => import('@/components/CompanionDrawingDraftCard.vue'))
const CompanionChatImages = defineAsyncComponent(() => import('@/components/CompanionChatImages.vue'))
const ChatReplyVariants = defineAsyncComponent(() => import('@/components/ChatReplyVariants.vue'))
</script>

<script setup lang="ts">
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import RuntimeImage from '@/components/visual/RuntimeImage.vue'
import ChatMessageText from '@/components/ChatMessageText.vue'
import ChatMessageActions from '@/components/ChatMessageActions.vue'
import type { ChatMessage } from '@/composables/chat/chatStorageTypes'

defineProps<{
  message: ChatMessage
  avatar?: string | null
  chibi: boolean
  streaming: boolean
  playing: boolean
  remembered: boolean
  hasAudio: (mid: string) => boolean
  canRegenerate?: boolean
  storyDisabled?: boolean
}>()
const emit = defineEmits<{ copy: [text: string]; remember: [message: ChatMessage]; play: [mid: string]; regenerate: []; fork: []; 'select-variant': [mid: string] }>()
</script>
