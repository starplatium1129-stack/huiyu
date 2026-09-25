<template>
  <div class="trash-wall" :style="{ '--wall-cols': columnCount }">
    <div class="trash-toolbar">
      <span class="trash-hint">软删保留 30 天，超期自动清理；点「恢复」放回展墙</span>
      <span class="trash-count" aria-live="polite">{{ trashItems.length }} 条</span>
    </div>
    <template v-if="trashItems.length">
      <article
        v-for="entry in trashItems"
        :key="entry.id"
        class="artwork trash-card"
        :class="{ 'artwork-pending': trashBusy === entry.id }"
      >
        <div class="artwork-media" style="--art-ratio: 1">
          <img
            v-if="trashThumbs[entry.id]"
            class="artwork-image"
            :src="trashThumbs[entry.id]"
            :alt="trashPrompt(entry)"
            loading="lazy"
            decoding="async"
          />
          <div v-else class="artwork-placeholder"><ArchiveIcon name="image" /></div>
        </div>
        <div class="artwork-caption">
          <span class="artwork-name truncate">{{ trashPrompt(entry) }}</span>
          <span class="artwork-date">删除于 {{ formatTrashTime(entry.deletedAt) }}</span>
        </div>
        <div class="artwork-tools">
          <StudioTooltip anchor content="恢复放回展墙">
            <button class="artwork-tool" type="button" :disabled="trashBusy === entry.id"
              :aria-label="`恢复作品：${trashPrompt(entry)}`"
              @click="emit('restore', entry.id)">
              <ArchiveIcon name="spark" /><span>{{ trashBusy === entry.id ? '恢复中…' : '恢复' }}</span>
            </button>
          </StudioTooltip>
        </div>
      </article>
    </template>
    <ArchiveStatePanel v-else kind="empty" title="回收站是空的"
      message="删除的作品会在这里保留 30 天，随时可以恢复。" />
  </div>
</template>

<script setup lang="ts">
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import ArchiveStatePanel from '@/components/visual/ArchiveStatePanel.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import type { TrashEntry } from '@/storage/artworkRepository'
import { formatTrashTime, trashPrompt } from '@/composables/gallery/galleryHelpers'

defineProps<{
  columnCount: number
  trashItems: TrashEntry[]
  trashThumbs: Record<string, string>
  trashBusy: string | number | null
}>()

const emit = defineEmits<{
  (e: 'restore', id: string | number): void
}>()
</script>
