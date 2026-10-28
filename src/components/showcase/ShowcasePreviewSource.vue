<template>
  <slot :image="image" :loaded="loaded" :failed="failed" :preview="preview" :preview-ready="previewReady" />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRuntimeImage } from '@/composables/useRuntimeImage'
import { useShowcaseCardPreview } from '@/composables/showcase/useShowcaseCardPreview'

const props = withDefaults(defineProps<{ src?: string; fullSrc?: string }>(), { src: '', fullSrc: '' })
const emit = defineEmits<{ load: [event: Event] }>()
const { image: thumbnail, loaded, failed } = useRuntimeImage(() => props.src)
const { attach, preview, previewReady } = useShowcaseCardPreview(() => props.src, () => props.fullSrc)
const image = computed(() => ({ ...thumbnail.value, onLoad: (event: Event) => {
  if (!thumbnail.value.onLoad(event)) return
  attach(event.target as HTMLImageElement)
  emit('load', event)
} }))
</script>
