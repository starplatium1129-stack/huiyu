<script setup lang="ts">
import { computed } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import type { ChatMessage } from '@/composables/chat/chatStorageTypes'

const props = defineProps<{ message: ChatMessage; disabled?: boolean }>()
const emit = defineEmits<{ select: [mid: string] }>()
const variants = computed(() => props.message.variants || [])
const index = computed(() => variants.value.findIndex(variant => variant.mid === props.message.mid))
function select(offset: number) {
  if (props.disabled || index.value < 0) return
  const variant = variants.value[index.value + offset]
  if (variant) emit('select', variant.mid)
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
.chat-reply-variants button { --variant-direction:90deg; --variant-press:.94; display:grid; place-items:center; width:var(--control-height-sm); height:var(--control-height-sm); padding:0; border:0; border-radius:var(--r-sm); background:transparent; color:var(--text-secondary); cursor:pointer; }
.chat-reply-variants button .archive-icon { width:16px; height:16px; transform:rotate(var(--variant-direction)); transition:transform var(--motion-press) var(--ease-out); }
.chat-reply-variants button:last-child { --variant-direction:-90deg; }
.chat-reply-variants button[aria-disabled='true'] { color:var(--text-disabled); cursor:default; }
.chat-reply-variants button:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
.chat-reply-variants button:active:not(:focus-visible):not([aria-disabled='true']) .archive-icon { transform:rotate(var(--variant-direction)) scale(var(--variant-press)); }
.chat-reply-variants button:focus-visible .archive-icon { transition:none; }
@media (hover:hover) and (pointer:fine) { .chat-reply-variants button:hover:not([aria-disabled='true']) { color:var(--text-primary); background:var(--bg-hover); } }
@media (prefers-reduced-motion:reduce) { :root:not([data-motion='full']) .chat-reply-variants button { --variant-press:1; } :root:not([data-motion='full']) .chat-reply-variants .archive-icon { transition:none; } }
:root:is([data-motion='reduce'],[data-motion='reduced']) .chat-reply-variants button { --variant-press:1; }
:root:is([data-motion='reduce'],[data-motion='reduced']) .chat-reply-variants .archive-icon { transition:none; }
</style>
