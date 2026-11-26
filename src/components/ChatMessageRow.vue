<template>
  <div class="message" :class="[message.role, { streaming, speaking: playing }]" :data-mid="message.mid" :data-has-copy="Boolean(message.content) || undefined">
    <div v-if="message.role === 'assistant'" class="message-avatar" :data-chibi="chibi || undefined" aria-hidden="true">
      <RuntimeImage :src="avatar" alt=""><template #fallback><ArchiveIcon name="character" /></template></RuntimeImage>
    </div>
    <div class="message-body">
      <form v-if="editing" class="message-edit-form" @submit.prevent="submitEdit">
        <label class="sr-only" :for="`edit-msg-${message.mid}`">编辑消息内容</label>
        <textarea
          :id="`edit-msg-${message.mid}`"
          ref="editInputRef"
          v-model="editDraft"
          class="textarea message-edit-textarea"
          maxlength="16000"
          rows="3"
          @keydown.esc.stop="cancelEdit"
          @keydown.ctrl.enter.prevent="submitEdit"
          @keydown.meta.enter.prevent="submitEdit"
        ></textarea>
        <div class="message-edit-actions">
          <span class="message-edit-hint">Ctrl/Cmd + Enter 保存 · Esc 取消</span>
          <button type="button" class="btn btn-ghost btn-sm" @click="cancelEdit">取消</button>
          <button type="submit" class="btn btn-primary btn-sm" :disabled="!editDraft.trim() || storyDisabled">保存</button>
        </div>
      </form>
      <div v-else class="message-bubbles">
        <div v-for="(text, index) in bubbles" :key="index" class="message-bubble"
          v-content-motion:up="(index === 0 ? arrival : streaming) ? `${message.mid}:${index}` : false">
          <ChatMessageText v-if="text" :text="text" :regex-rules="regexRules" />
          <template v-if="index === bubbles.length - 1">
            <ChatMessageAttachments :message="message" />
            <ChatTurnIndicator v-if="!message.content && !message.drawingBatchId && streaming"
              :label="activity || '正在回复…'" animated />
          </template>
        </div>
      </div>
      <span v-if="message.stopped || playing" class="message-note">{{ message.stopped ? '已停止' : '播放中' }}</span>
      <span v-if="message.matchedLore?.length" class="message-note">命中世界书：{{ message.matchedLore.join(' · ') }}</span>
      <ChatReplyVariants v-if="message.variants?.length" :message="message" :disabled="storyDisabled" @select="emit('select-variant', $event)" />
    </div>
    <ChatMessageActions :can-copy="Boolean(message.content)" :can-remember="message.role === 'user' && Boolean(message.mid)"
      :remembered="remembered" :can-play="message.role === 'assistant' && Boolean(message.mid && hasAudio(message.mid))"
      :playing="playing" :memories="message.recalledMemories" :matched-lore="message.matchedLore"
      :can-regenerate="canRegenerate" :can-continue="canContinue" :can-edit="canEdit && Boolean(message.content)"
      :can-illustrate="canIllustrate && Boolean(message.content)" :illustrating="illustrating"
      :can-delete="canDelete" :can-truncate="canTruncate" :reply-missing="message.role === 'user'"
      :can-fork="Boolean(message.content)" :story-disabled="storyDisabled"
      @copy="emit('copy', message.content)" @remember="emit('remember', message)" @play="message.mid && emit('play', message.mid)"
      @regenerate="emit('regenerate')" @continue="emit('continue')" @edit="startEdit" @illustrate="emit('illustrate', message)"
      @delete="requestDelete" @truncate="requestTruncate" @fork="emit('fork')" />
  </div>
</template>

<script lang="ts">
import { defineAsyncComponent } from 'vue'

const ChatReplyVariants = defineAsyncComponent(() => import('@/components/ChatReplyVariants.vue'))
</script>

<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import RuntimeImage from '@/components/visual/RuntimeImage.vue'
import ChatMessageText from '@/components/ChatMessageText.vue'
import ChatMessageAttachments from '@/components/ChatMessageAttachments.vue'
import ChatTurnIndicator from '@/components/ChatTurnIndicator.vue'
import ChatMessageActions from '@/components/ChatMessageActions.vue'
import type { ChatMessage } from '@/composables/chat/chatStorageTypes'
import { chatMessageBubbles } from '@/utils/chatMessageBubbles'
import type { ChatRegexRule } from '@/utils/chatRpSettings'
import { confirmAction } from '@/composables/useConfirm'

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
  canContinue?: boolean
  canEdit?: boolean
  canIllustrate?: boolean
  illustrating?: boolean
  canDelete?: boolean
  canTruncate?: boolean
  disableBubbleSplit?: boolean
  regexRules?: readonly ChatRegexRule[]
  storyDisabled?: boolean
}>()
const bubbles = computed(() => chatMessageBubbles(props.message, props.disableBubbleSplit))
const emit = defineEmits<{
  copy: [text: string]
  remember: [message: ChatMessage]
  play: [mid: string]
  regenerate: []
  continue: []
  edit: [mid: string, content: string]
  illustrate: [message: ChatMessage]
  delete: []
  truncate: []
  fork: []
  'select-variant': [mid: string]
}>()

const editing = ref(false)
const editDraft = ref('')
const editInputRef = ref<HTMLTextAreaElement>()

function startEdit() {
  if (props.storyDisabled || !props.message.content) return
  editDraft.value = props.message.content
  editing.value = true
  void nextTick(() => {
    editInputRef.value?.focus()
  })
}

function cancelEdit() {
  editing.value = false
  editDraft.value = ''
}

function submitEdit() {
  const trimmed = editDraft.value.trim()
  if (!trimmed || props.storyDisabled) return
  editing.value = false
  if (trimmed !== props.message.content.trim()) {
    emit('edit', props.message.mid, trimmed)
  }
}

async function requestDelete() {
  if (props.storyDisabled) return
  const ok = await confirmAction({
    title: '删除这条消息？',
    message: '仅移除当前这一条消息，后续对话保持不变。此操作无法撤销。',
    confirmLabel: '删除',
    danger: true,
  })
  if (ok) emit('delete')
}

async function requestTruncate() {
  if (props.storyDisabled) return
  const ok = await confirmAction({
    title: '从此条消息起回退？',
    message: '将移除这条消息及其后的所有对话，方便重新推进剧情。可先通过“从这里另开剧情”保留分支。',
    confirmLabel: '确认回退',
    danger: true,
  })
  if (ok) emit('truncate')
}
</script>

<style scoped>
.message-edit-form { display:grid; gap:var(--s-2); width:min(560px, 100%); padding:var(--s-2); border:1px solid var(--accent); border-radius:var(--r-lg); background:var(--bg-surface); }
.message-edit-textarea { width:100%; height:auto; min-block-size:3lh; max-block-size:16lh; font:400 var(--fs-body-sm)/var(--lh-body) var(--font-sans); }
@supports (field-sizing:content) { .message-edit-textarea { field-sizing:content; resize:none; } }
.message-edit-actions { display:flex; align-items:center; justify-content:flex-end; flex-wrap:wrap; gap:var(--s-2); }
.message-edit-hint { margin-right:auto; color:var(--text-secondary); font:400 var(--fs-label-xs)/var(--lh-label) var(--font-sans); }
</style>
