<template>
  <div ref="surface" class="studio-thumb">
    <img v-if="preview.url.value" :src="preview.url.value" alt="" decoding="async" draggable="false" />
    <span v-else-if="preview.error.value" class="studio-caption">预览未就绪</span>
    <ArchiveIcon
      v-else
      :name="version?.mime.startsWith('audio/') ? 'speaker' : version?.mime.startsWith('video/') ? 'clap' : 'image'"
    />
  </div>
</template>
<script setup lang="ts">
import { onActivated, onDeactivated, ref, watch } from 'vue'
import { useElementVisibility } from '@vueuse/core'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { useOriginalImage } from '@/composables/useOriginalImage'
import { cardPreviewImage } from '@/utils/cardPreviewImage'
import type { StudioAssetVersion } from '@/storage/studioProjectRepository'
import { imageVersion } from './projectAssets'
const props = defineProps<{ version?: StudioAssetVersion }>()
const preview = useOriginalImage()
const surface = ref<HTMLElement | null>(null)
const near = useElementVisibility(surface, { rootMargin: '192px', initialValue: typeof IntersectionObserver === 'undefined' })
const active = ref(true)
onActivated(() => { active.value = true })
onDeactivated(() => { active.value = false })
watch(
  [() => props.version?.id, preview.session, near, active],
  () => {
    preview.release()
    const version = props.version
    if (!active.value || !near.value || !version || !imageVersion(version)) return
    void preview.load({
      current: () => active.value && near.value && props.version?.id === version.id,
      read: async (signal, repository) => {
        const alias = version.mediaAlias
        const thumbnail = await repository.getThumbnail(alias).catch(() => null)
        signal.throwIfAborted()
        if (thumbnail) return thumbnail
        const cached = await repository.getPreview?.(alias, 320, signal).catch(() => null)
        signal.throwIfAborted()
        if (cached) return cached
        const blob = await repository.getImage(alias, signal)
        return blob ? ((await cardPreviewImage(blob, 320, signal))?.blob ?? null) : null
      },
    })
  },
  { immediate: true }
)
</script>
