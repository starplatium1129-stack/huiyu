<script setup lang="ts">
import { computed } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import type { ChatMessage } from '@/composables/chat/chatStorageTypes'

const props = defineProps<{ message: ChatMessage; disabled?: boolean }>()
const emit = defineEmits<{ select: [mid: string] }>()
const variants = computed(() => props.message.variants || [])
const index = computed(() => variants.value.findIndex(variant => variant.mid === props.message.mid))
function select(offset: number) {
  const variant = variants.value[index.value + offset]
  if (!props.disabled && variant) emit('select', variant.mid)
}
</script>

<template>
  <div v-if="variants.length > 1 || variants.length && index < 0" class="chat-reply-variants" role="group" aria-label="回复备选">
    <button type="button" aria-label="上一个回复备选" :aria-disabled="disabled || index <= 0" @click="select(-1)"><ArchiveIcon name="chevron-down" /></button>
    <span role="status" aria-live="polite">{{ index < 0 ? '生成中' : `${index + 1} / ${variants.length}` }}</span>
    <button type="button" aria-label="下一个回复备选" :aria-disabled="disabled || index < 0 || index >= variants.length - 1" @click="select(1)"><ArchiveIcon name="chevron-down" /></button>
  </div>
</template>

<style scoped>
.chat-reply-variants { display:flex; align-items:center; gap:var(--s-1); margin-top:var(--s-2); color:var(--text-secondary); font:400 var(--fs-label-xs)/var(--lh-label) var(--font-sans); }
.chat-reply-variants span { min-width:5ch; text-align:center; font-variant-numeric:tabular-nums; }
.chat-reply-variants button { display:grid; place-items:center; width:var(--control-height-sm); height:var(--control-height-sm); padding:0; border:0; border-radius:var(--r-sm); background:transparent; color:var(--text-secondary); cursor:pointer; transition:transform var(--motion-press) var(--ease-out); }
.chat-reply-variants button .archive-icon { width:16px; height:16px; transform:rotate(90deg); }
.chat-reply-variants button:last-child .archive-icon { transform:rotate(-90deg); }
.chat-reply-variants button[aria-disabled='true'] { color:var(--text-disabled); cursor:default; }
.chat-reply-variants button:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
.chat-reply-variants button:active:not([aria-disabled='true']) { transform:scale(.94); }
@media (hover:hover) and (pointer:fine) { .chat-reply-variants button:hover:not([aria-disabled='true']) { color:var(--text-primary); background:var(--bg-hover); } }
@media (prefers-reduced-motion:reduce) { :root:not([data-motion='full']) .chat-reply-variants button { transition:none; } }
:root:is([data-motion='reduce'],[data-motion='reduced']) .chat-reply-variants button { transition:none; }
</style>
