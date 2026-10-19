<script setup lang="ts">
import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from 'reka-ui'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioDropdownMenu from '@/components/ui/StudioDropdownMenu.vue'

defineProps<{ canCopy: boolean; canRemember: boolean; remembered: boolean; canPlay: boolean; playing: boolean; memories?: string[];
  canRegenerate?: boolean; canFork?: boolean; storyDisabled?: boolean; replyMissing?: boolean }>()
const emit = defineEmits<{ copy: []; remember: []; play: []; regenerate: []; fork: [] }>()
</script>

<template>
  <StudioDropdownMenu label="消息操作" :side-offset="6">
    <template #trigger>
      <button class="message-actions-trigger" type="button" aria-label="消息操作"><ArchiveIcon name="chevron-down" /></button>
    </template>
    <template #default="{ run }">
      <DropdownMenuItem v-if="canCopy" class="chat-more-item" @select="run(() => emit('copy'))"><ArchiveIcon name="copy" /><span>复制</span></DropdownMenuItem>
      <DropdownMenuItem v-if="canRemember" class="chat-more-item" :disabled="remembered" @select="run(() => emit('remember'))">
        <ArchiveIcon :name="remembered ? 'success' : 'pin'" /><span>{{ remembered ? '已记住' : '记住这句话' }}</span>
      </DropdownMenuItem>
      <DropdownMenuItem v-if="canPlay" class="chat-more-item" @select="run(() => emit('play'))"><ArchiveIcon name="sound" /><span>{{ playing ? '重新播放' : '播放语音' }}</span></DropdownMenuItem>
      <template v-if="canRegenerate || canFork">
        <DropdownMenuSeparator class="chat-more-separator" />
        <DropdownMenuItem v-if="canRegenerate" class="chat-more-item" :disabled="storyDisabled" @select="run(() => emit('regenerate'))">
          <ArchiveIcon name="refresh" /><span>{{ replyMissing ? '生成回复' : '重新生成回复' }}</span>
        </DropdownMenuItem>
        <DropdownMenuItem v-if="canFork" class="chat-more-item" :disabled="storyDisabled" @select="run(() => emit('fork'))">
          <ArchiveIcon name="chat" /><span>从这里另开剧情</span>
        </DropdownMenuItem>
      </template>
      <template v-if="memories?.length">
        <DropdownMenuSeparator class="chat-more-separator" />
        <DropdownMenuLabel class="chat-more-label">相关记忆</DropdownMenuLabel>
        <p v-for="memory in memories" :key="memory" class="message-action-memory">{{ memory }}</p>
      </template>
    </template>
  </StudioDropdownMenu>
</template>

<style>
.message-actions-trigger { display:grid; place-items:center; flex:none; width:var(--control-height-sm); height:var(--control-height-sm); padding:0; border:0; border-radius:var(--r-sm); background:transparent; color:var(--text-secondary); cursor:pointer; }
.message-actions-trigger .archive-icon { width:16px; height:16px; }
.message-actions-trigger:is(:hover,[data-state='open']) { background:var(--bg-hover); color:var(--text-primary); }
.message-actions-trigger:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
.message-action-memory { margin:var(--s-1) var(--s-3); color:var(--text-secondary); font:400 var(--fs-label)/var(--lh-body) var(--font-sans); overflow-wrap:anywhere; }
</style>
