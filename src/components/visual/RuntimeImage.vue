<template>
  <slot :image="image" :loaded="loaded" :failed="failed">
    <img v-if="image.src && !failed" v-bind="{ ...$attrs, srcset: undefined, ...image }" />
    <slot v-else name="fallback" />
  </slot>
</template>

<script setup lang="ts">
import { useRuntimeImage } from '@/composables/useRuntimeImage'
import { computed } from 'vue'
defineOptions({ inheritAttrs: false })
const props = defineProps<{ src?: string | null }>()
const emit = defineEmits<{ load: [event: Event]; error: [event: Event] }>()
const resource = useRuntimeImage(() => props.src)
const { loaded, failed } = resource
// This component owns one URL. Responsive picture/source selection stays explicit.
const image = computed(() => ({ ...resource.image.value,
  onLoad: (event: Event) => { if (resource.image.value.onLoad(event)) emit('load', event) },
  onError: (event: Event) => { if (resource.image.value.onError(event)) emit('error', event) },
}))
</script>
