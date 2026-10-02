<script setup lang="ts">
import { ref } from 'vue'
import {
  DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuPortal,
  DropdownMenuRoot, DropdownMenuSeparator, DropdownMenuTrigger,
} from 'reka-ui'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'

const emit = defineEmits<{
  (e: 'clear-all'): void
  (e: 'toggle-archive'): void
  (e: 'toggle-memory'): void
  (e: 'toggle-profile'): void
}>()
const moreOpen = ref(false)
const trigger = ref<{ $el: HTMLElement } | null>(null)
const actionSelected = ref(false)
const pointerOpened = ref(false)

function runRoomAction(action: () => void) {
  actionSelected.value = true
  moreOpen.value = false
  // Restore before emitting: an action may immediately open a confirmation dialog.
  trigger.value?.$el.focus({ preventScroll: true })
  action()
}

function closeAutoFocus(event: Event) {
  // Do not let the menu's delayed focus restoration steal focus from the new dialog.
  if (actionSelected.value) event.preventDefault()
  actionSelected.value = false
}
</script>

<template>
  <DropdownMenuRoot v-model:open="moreOpen" :modal="false">
    <DropdownMenuTrigger ref="trigger" as-child @pointerdown="pointerOpened = true" @keydown="pointerOpened = false">
      <button class="btn btn-ghost chat-more-trigger" type="button">
        更多<ArchiveIcon name="chevron-down" class="chat-more-caret" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuPortal>
      <DropdownMenuContent class="chat-more-menu" align="end" :side-offset="8" :collision-padding="12"
        :data-pointer-open="pointerOpened" hide-when-detached loop aria-label="更多房间操作" :aria-labelledby="undefined"
        @close-auto-focus="closeAutoFocus" @keydown.capture="pointerOpened = false">
        <DropdownMenuLabel class="chat-more-label">房间与记忆</DropdownMenuLabel>
        <DropdownMenuItem class="chat-more-item" @select="runRoomAction(() => emit('toggle-archive'))">
          <ArchiveIcon name="chat" /><span>对话归档</span>
        </DropdownMenuItem>
        <DropdownMenuItem class="chat-more-item" @select="runRoomAction(() => emit('toggle-memory'))">
          <ArchiveIcon name="pin" /><span>长期记忆</span>
        </DropdownMenuItem>
        <DropdownMenuItem class="chat-more-item" @select="runRoomAction(() => emit('toggle-profile'))">
          <ArchiveIcon name="character" /><span>我的档案</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator class="chat-more-separator" />
        <DropdownMenuItem class="chat-more-item is-danger" @select="runRoomAction(() => emit('clear-all'))">
          <ArchiveIcon name="broom" /><span>清空聊天内容与个人档案</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
</template>

<!-- The menu is portalled so its surface must not depend on the chat page ancestor. -->
<style>
@reference "../assets/css/tailwind.css";
.chat-more-trigger .chat-more-caret { @apply tw:ml-s-1 tw:w-[14px] tw:h-[14px] tw:text-muted; }
.chat-more-trigger[data-state='open'] .chat-more-caret { transform:rotate(180deg); }
.chat-more-menu {
  @apply tw:flex tw:flex-col tw:p-s-2 tw:border tw:border-solid tw:border-soft tw:rounded-xl tw:bg-surface tw:text-primary tw:shadow-(--shadow-lg);
  z-index:var(--z-popover);
  width:min(272px,calc(100vw - 24px));
  max-height:var(--reka-dropdown-menu-content-available-height,calc(100dvh - 24px));
  overflow-y:auto;
  overscroll-behavior:contain;
  transform-origin:var(--reka-dropdown-menu-content-transform-origin,top right);
  transition:opacity var(--motion-hover) var(--ease-out),transform var(--motion-hover) var(--ease-out);
}
.chat-more-label { @apply tw:px-s-3 tw:py-s-2 tw:text-muted tw:text-label-xs; font-weight:600; }
.chat-more-item { @apply tw:flex tw:items-center tw:gap-s-2 tw:min-h-[40px] tw:py-s-2 tw:px-s-3 tw:rounded-md tw:text-secondary tw:text-label tw:cursor-pointer; outline:none; flex-shrink:0; }
.chat-more-item > span { min-width:0; overflow-wrap:anywhere; }
.chat-more-item .archive-icon { @apply tw:w-[16px] tw:h-[16px] tw:shrink-0; }
.chat-more-item[data-highlighted] { background:var(--accent-soft); color:var(--text-primary); }
.chat-more-menu[data-pointer-open='false'] .chat-more-item[data-highlighted] { outline:2px solid var(--accent); outline-offset:-2px; }
.chat-more-item.is-danger { color:var(--danger-text); }
.chat-more-item.is-danger[data-highlighted] { background:color-mix(in srgb,var(--danger) 12%,var(--bg-surface)); }
.chat-more-separator { height:1px; margin:var(--s-2) var(--s-1); background:var(--border-soft); flex-shrink:0; }
@starting-style { .chat-more-menu[data-state='open'][data-pointer-open='true'] { opacity:0; transform:scale(.97); } }
.chat-more-menu[data-pointer-open='false'] { transition:none; }
@media(prefers-reduced-motion:reduce) { .chat-more-menu { transition:none; } }
@media(forced-colors:active) { .chat-more-item[data-highlighted] { outline:2px solid Highlight; outline-offset:-2px; } }
</style>
