<script setup lang="ts">
import { computed, ref } from 'vue'
import { resolveRuntimeUrl, runtimeResourceCors } from '@/platform/runtimeUrl'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'

const props = defineProps<{ src: string }>()
const emit = defineEmits<{ painted: [url: string]; retired: [] }>()
const requested = computed(() => resolveRuntimeUrl(props.src))
const painted = ref('')
const layers = computed(() => painted.value && requested.value && painted.value !== requested.value
  ? [painted.value, requested.value] : requested.value ? [requested.value] : [])

async function show(event: Event) {
  const image = event.currentTarget as HTMLImageElement
  const url = image.getAttribute('src')
  if (url !== requested.value) return
  try { await image.decode() } catch { return }
  // Keep the old node on screen until the replacement node itself is paintable.
  if (image.isConnected && url === requested.value && image.naturalWidth) {
    painted.value = url
    emit('painted', url)
  }
}
</script>

<template>
  <img v-for="url in layers" :key="url" :src="url" :crossorigin="runtimeResourceCors()" :data-painted="painted === url || undefined"
    class="recent-cover-img" alt="" loading="lazy" decoding="async" @load="show" @vue:unmounted="emit('retired')" />
  <ArchiveIcon v-if="!painted || !requested" name="image" class="placeholder" />
</template>
