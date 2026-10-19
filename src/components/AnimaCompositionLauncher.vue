<script setup lang="ts">
import { watch } from 'vue'
import AnimaCompositionControls from '@/components/AnimaCompositionControls.vue'
import { useAnimaComposition } from '@/composables/generation/useAnimaComposition'
import type { AnimaCompositionBindings } from '@/composables/generation/useAnimaComposition'

const props = defineProps<{ bindings: AnimaCompositionBindings; open: boolean }>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()
// DeferredToolLauncher creates this owner once, and retains it after closing.
const session = useAnimaComposition(props.bindings)
watch(() => props.open, open => {
  if (open) session.openEditor()
  else session.closeEditor()
}, { immediate: true, flush: 'sync' })
watch(session.editorOpen, open => { if (open !== props.open) emit('update:open', open) }, { flush: 'sync' })
</script>

<template>
  <AnimaCompositionControls :session="session" />
</template>
