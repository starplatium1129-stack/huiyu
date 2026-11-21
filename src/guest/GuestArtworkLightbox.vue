<script setup lang="ts">
import { computed } from 'vue'
import StudioDialog from '@/components/ui/StudioDialog.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import ZoomableImageViewer from '@/components/visual/ZoomableImageViewer.vue'
import type { GuestHistoryItem } from './useGuestHistory'

const open = defineModel<boolean>('open', { default: false })
const props = defineProps<{
  artwork: GuestHistoryItem | null
  characterId?: string
}>()
const emit = defineEmits<{
  download: [item: GuestHistoryItem]
}>()

const metaSummary = computed(() => {
  const item = props.artwork
  if (!item) return ''
  const parts: string[] = []
  if (item.width && item.height) parts.push(`${item.width} × ${item.height}`)
  if (typeof item.seed === 'number') parts.push(`种子 ${item.seed}`)
  if (item.elapsedMs > 0) parts.push(`用时 ${Math.max(1, Math.round(item.elapsedMs / 1000))} 秒`)
  return parts.join(' · ')
})
</script>

<template>
  <StudioDialog
    v-model:open="open"
    size="lg"
    borderless-header
    :character="characterId"
    :title="artwork?.title || '作品细节预览'"
    :subtitle="metaSummary || undefined"
    close-label="关闭大图查看器"
    dialog-class="guest-lightboxDialog"
  >
    <div v-if="artwork" class="guest-lightboxStage">
      <ZoomableImageViewer
        :src="artwork.url"
        :alt="artwork.title || '生成的画面'"
        :image-key="artwork.id"
      />
    </div>

    <template #footer="{ close }">
      <div class="guest-lightboxFooter">
        <p v-if="artwork?.prompt" class="guest-lightboxPrompt">{{ artwork.prompt }}</p>
        <div class="guest-lightboxActions">
          <button class="btn btn-quiet" type="button" @click="close('')">关闭</button>
          <button
            v-if="artwork"
            class="btn btn-primary"
            type="button"
            @click="emit('download', artwork)"
          >
            <ArchiveIcon name="download" />下载原图
          </button>
        </div>
      </div>
    </template>
  </StudioDialog>
</template>

<style scoped>
.guest-lightboxStage {
  position: relative;
  inline-size: 100%;
  block-size: min(68dvh, 46rem);
  min-block-size: 18rem;
  border: 1px solid var(--border-soft);
  border-radius: var(--r-md);
  background: var(--art-mat);
  overflow: hidden;
}

.guest-lightboxFooter {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-3);
  inline-size: 100%;
}

.guest-lightboxPrompt {
  flex: 1 1 16rem;
  min-inline-size: 0;
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--fs-label-xs);
  line-height: var(--lh-label);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.guest-lightboxActions {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  margin-inline-start: auto;
}
</style>
