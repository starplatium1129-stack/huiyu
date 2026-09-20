<template>
  <div v-if="visible && text" class="companion-float-reminder companion-reply-preview" @pointerenter="hold" @pointerleave="release" @focusin="hold" @focusout="release">
    <span>{{ name }}</span><p>{{ text }}</p>
    <button type="button" aria-label="展开完整回复" @click="$emit('open')"><ArchiveIcon name="chat" /></button>
  </div>
</template>
<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
const props = defineProps<{ text: string; name: string }>()
defineEmits<{ open: [] }>()
const visible = ref(false)
let timer = 0
function hold() { clearTimeout(timer) }
function release() {
  hold()
  timer = window.setTimeout(() => { if (window.getSelection()?.toString()) release(); else visible.value = false }, 12000)
}
watch(() => props.text, () => { visible.value = Boolean(props.text); release() }, { immediate: true })
onBeforeUnmount(hold)
</script>
