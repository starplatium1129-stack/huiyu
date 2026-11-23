<template>
  <div class="message" :class="[message.role, { streaming, speaking: playing }]" :data-mid="message.mid" :data-has-copy="Boolean(message.content) || undefined">
    <div v-if="message.role === 'assistant'" class="message-avatar" :data-chibi="chibi || undefined" aria-hidden="true">
      <RuntimeImage :src="avatar" alt=""><template #fallback><ArchiveIcon name="character" /></template></RuntimeImage>
    </div>
    <div class="message-body">
      <div class="message-bubbles">
        <div v-for="(text, index) in bubbles" :key="index" class="message-bubble"
          v-content-motion:up="(index === 0 ? arrival : streaming) ? `${message.mid}:${index}` : false">
          <ChatMessageText v-if="text" :text="text" />
          <template v-if="index === bubbles.length - 1">
            <ChatMessageAttachments :message="message" />
            <ChatTurnIndicator v-if="!message.content && !message.drawingBatchId && streaming"
              :label="activity || '正在回复…'" animated />
          </template>
        </div>
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

const ChatReplyVariants = defineAsyncComponent(() => import('@/components/ChatReplyVariants.vue'))
</script>

<script setup lang="ts">
import { computed } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import RuntimeImage from '@/components/visual/RuntimeImage.vue'
import ChatMessageText from '@/components/ChatMessageText.vue'
import ChatMessageAttachments from '@/components/ChatMessageAttachments.vue'
import ChatTurnIndicator from '@/components/ChatTurnIndicator.vue'
import ChatMessageActions from '@/components/ChatMessageActions.vue'
import type { ChatMessage } from '@/composables/chat/chatStorageTypes'
import { chatMessageBubbles } from '@/utils/chatMessageBubbles'

const props = defineProps<{
  message: ChatMessage
  avatar?: string | null
  chibi: boolean
  streaming: boolean
  arrival?: boolean
  activity?: string
  playing: boolean
  remembered: boolean
  hasAudio: (mid: string) => boolean
  canRegenerate?: boolean
  storyDisabled?: boolean
}>()
const bubbles = computed(() => chatMessageBubbles(props.message))
const emit = defineEmits<{ copy: [text: string]; remember: [message: ChatMessage]; play: [mid: string]; regenerate: []; fork: []; 'select-variant': [mid: string] }>()
</script>
