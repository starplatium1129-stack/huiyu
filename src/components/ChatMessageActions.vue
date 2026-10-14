<script setup lang="ts">
import { onActivated, onDeactivated, ref } from 'vue'
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuPortal,
  DropdownMenuRoot, DropdownMenuSeparator, DropdownMenuTrigger } from 'reka-ui'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'

defineProps<{ canCopy: boolean; canRemember: boolean; remembered: boolean; canPlay: boolean; playing: boolean; memories?: string[] }>()
const emit = defineEmits<{ copy: []; remember: []; play: [] }>()
const open = ref(false), trigger = ref<{ $el: HTMLElement } | null>(null)
let active = true, actionSelected = false
onActivated(() => { active = true })
onDeactivated(() => { active = false; open.value = false })
function run(action: 'copy' | 'remember' | 'play') {
  actionSelected = true
  open.value = false
  trigger.value?.$el.focus({ preventScroll: true })
  if (action === 'copy') emit('copy')
  else if (action === 'remember') emit('remember')
  else emit('play')
}
function closeAutoFocus(event: Event) {
  if (!active || actionSelected) event.preventDefault()
  actionSelected = false
}
</script>

<template>
  <DropdownMenuRoot v-model:open="open" :modal="false">
    <DropdownMenuTrigger ref="trigger" as-child>
      <button class="message-actions-trigger" type="button" aria-label="消息操作"><ArchiveIcon name="chevron-down" /></button>
    </DropdownMenuTrigger>
    <DropdownMenuPortal>
      <DropdownMenuContent class="chat-more-menu message-actions-menu" align="end" :side-offset="6" :collision-padding="12"
        hide-when-detached loop aria-label="消息操作" :aria-labelledby="undefined" @close-auto-focus="closeAutoFocus">
        <DropdownMenuItem v-if="canCopy" class="chat-more-item" @select="run('copy')"><ArchiveIcon name="copy" /><span>复制</span></DropdownMenuItem>
        <DropdownMenuItem v-if="canRemember" class="chat-more-item" :disabled="remembered" @select="run('remember')">
          <ArchiveIcon :name="remembered ? 'success' : 'pin'" /><span>{{ remembered ? '已记住' : '记住这句话' }}</span>
        </DropdownMenuItem>
        <DropdownMenuItem v-if="canPlay" class="chat-more-item" @select="run('play')"><ArchiveIcon name="sound" /><span>{{ playing ? '重新播放' : '播放语音' }}</span></DropdownMenuItem>
        <template v-if="memories?.length">
          <DropdownMenuSeparator class="chat-more-separator" />
          <DropdownMenuLabel class="chat-more-label">相关记忆</DropdownMenuLabel>
          <p v-for="memory in memories" :key="memory" class="message-action-memory">{{ memory }}</p>
        </template>
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
</template>

<style>
.message-actions-trigger { display:grid; place-items:center; flex:none; width:28px; height:28px; padding:0; border:0; border-radius:8px; background:transparent; color:var(--text-secondary); cursor:pointer; }
.message-actions-trigger .archive-icon { width:14px; height:14px; }
.message-actions-trigger:is(:hover,[data-state='open']) { background:var(--bg-hover); color:var(--text-primary); }
.message-actions-trigger:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.message-actions-menu .chat-more-item[data-disabled] { color:var(--text-disabled); cursor:default; }
.message-actions-menu .chat-more-item[data-highlighted] { outline:2px solid var(--accent); outline-offset:-2px; }
.message-action-memory { margin:4px 12px; color:var(--text-secondary); font:400 13px/1.6 var(--font-sans); overflow-wrap:anywhere; }
</style>
