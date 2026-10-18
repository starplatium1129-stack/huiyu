<script setup lang="ts">
import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from 'reka-ui'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioDropdownMenu from '@/components/ui/StudioDropdownMenu.vue'

const emit = defineEmits<{
  (e: 'clear-all'): void
  (e: 'toggle-archive'): void
  (e: 'toggle-memory'): void
  (e: 'toggle-profile'): void
}>()
</script>

<template>
  <StudioDropdownMenu label="更多房间操作" :side-offset="8">
    <template #trigger>
      <button class="btn btn-ghost chat-more-trigger" type="button" aria-label="更多聊天操作">
        <ArchiveIcon name="menu" />
      </button>
    </template>
    <template #default="{ run }">
      <DropdownMenuLabel class="chat-more-label">房间与记忆</DropdownMenuLabel>
      <DropdownMenuItem class="chat-more-item" @select="run(() => emit('toggle-archive'))">
        <ArchiveIcon name="chat" /><span>对话归档</span>
      </DropdownMenuItem>
      <DropdownMenuItem class="chat-more-item" @select="run(() => emit('toggle-memory'))">
        <ArchiveIcon name="pin" /><span>长期记忆</span>
      </DropdownMenuItem>
      <DropdownMenuItem class="chat-more-item" @select="run(() => emit('toggle-profile'))">
        <ArchiveIcon name="character" /><span>我的档案</span>
      </DropdownMenuItem>
      <DropdownMenuSeparator class="chat-more-separator" />
      <DropdownMenuItem class="chat-more-item is-danger" @select="run(() => emit('clear-all'))">
        <ArchiveIcon name="broom" /><span>清空聊天内容与个人档案</span>
      </DropdownMenuItem>
    </template>
  </StudioDropdownMenu>
</template>
