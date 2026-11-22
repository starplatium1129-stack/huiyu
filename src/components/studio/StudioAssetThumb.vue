<template>
  <div class="studio-thumb">
    <img v-if="preview.url.value" :src="preview.url.value" alt="" decoding="async" draggable="false" />
    <span v-else-if="preview.error.value" class="studio-caption">预览未就绪</span>
    <ArchiveIcon
      v-else
      :name="version?.mime.startsWith('audio/') ? 'speaker' : version?.mime.startsWith('video/') ? 'clap' : 'image'"
    />
  </div>
</template>
<script setup lang="ts">
import { watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { useOriginalImage } from '@/composables/useOriginalImage'
import { cardPreviewImage } from '@/utils/cardPreviewImage'
import type { StudioAssetVersion } from '@/storage/studioProjectRepository'
import { imageVersion } from './projectAssets'
const props = defineProps<{ version?: StudioAssetVersion }>()
const preview = useOriginalImage()
watch(
  [() => props.version?.id, preview.session],
  () => {
    preview.release()
    const version = props.version
    if (!version || !imageVersion(version)) return
    void preview.load({
      current: () => props.version?.id === version.id,
      read: async (signal, repository) => {
        const alias = version.mediaAlias
        const cached =
          (await repository.getThumbnail(alias).catch(() => null)) ||
          (await repository.getPreview?.(alias, 320, signal).catch(() => null))
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
