<template>
  <div class="trash-wall" :style="{ '--wall-cols': columnCount }" :aria-busy="trashClearing || trashLoading">
    <div v-if="trashItems.length || trashClearing" class="trash-toolbar">
      <span class="trash-hint">删除的作品保留 30 天，可恢复，也可提前清空</span>
      <div class="trash-actions">
        <span class="trash-count" aria-live="polite">{{ trashLoading ? '读取中…' : trashError ? '数量待确认' : `${trashItems.length} 幅作品` }}</span>
        <button class="btn btn-ghost btn-danger btn-sm" type="button"
          :disabled="!trashItems.length || trashBusy !== null || trashClearing" @click="emit('clear')">
          <ArchiveIcon name="broom" />{{ trashClearing ? '清理中…' : '清空回收站' }}
        </button>
      </div>
    </div>
    <ArchiveStatePanel v-if="trashLoading" kind="loading" title="正在读取回收站" :compact="!!trashItems.length" />
    <ArchiveStatePanel v-else-if="trashError" kind="error" title="回收站读取失败" :message="trashError" :compact="!!trashItems.length">
      <button class="btn btn-primary" type="button" :disabled="trashClearing" @click="emit('reload')">重新读取</button>
    </ArchiveStatePanel>
    <template v-if="trashItems.length">
      <article
        v-for="entry in visibleEntries"
        :key="entry.id"
        class="artwork trash-card"
        :class="{ 'artwork-pending': trashBusy === entry.id }"
      >
        <div class="artwork-media" style="--art-ratio: 1">
          <img :crossorigin="runtimeResourceCors()"
            v-if="thumbs[entry.id]"
            class="artwork-image"
            :src="resolveRuntimeUrl(thumbs[entry.id])"
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
            <button class="btn btn-ghost btn-sm trash-restore" type="button" :disabled="trashBusy !== null || trashClearing"
              :aria-label="`恢复作品：${trashPrompt(entry)}`"
              @click="emit('restore', entry.id)">
              <ArchiveIcon name="spark" /><span>{{ trashBusy === entry.id ? '恢复中…' : '恢复' }}</span>
            </button>
          </StudioTooltip>
        </div>
      </article>
    </template>
    <nav v-if="pageCount > 1" class="trash-pagination" aria-label="回收站分页">
      <button class="btn btn-ghost btn-sm" type="button" :disabled="page === 1" @click="page--">上一页</button>
      <span aria-live="polite">第 {{ page }} / {{ pageCount }} 页 · 每页 {{ PAGE_SIZE }} 幅</span>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="page === pageCount" @click="page++">下一页</button>
    </nav>
    <ArchiveStatePanel v-if="!trashItems.length && !trashLoading && !trashError" kind="empty" title="回收站是空的"
      message="删除的作品会在这里保留 30 天，随时可以恢复。" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useHistoryThumbnails } from '@/composables/prompt/useHistoryThumbnails'
import { resolveRuntimeUrl, runtimeResourceCors } from '@/platform/runtimeUrl'

import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import ArchiveStatePanel from '@/components/visual/ArchiveStatePanel.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import type { TrashEntry } from '@/storage/artworkRepository'
import { formatTrashTime, trashPrompt } from '@/composables/gallery/galleryHelpers'

const props = defineProps<{
  columnCount: number
  trashItems: TrashEntry[]
  trashBusy: string | number | null
  trashClearing: boolean
  trashLoading: boolean
  trashError: string
}>()

const PAGE_SIZE = 12
const page = ref(1)
const pageCount = computed(() => Math.max(1, Math.ceil(props.trashItems.length / PAGE_SIZE)))
watch(pageCount, count => { page.value = Math.min(page.value, count) }, { flush: 'sync' })
const visibleEntries = computed(() => props.trashItems.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE))
// Metadata stays complete for restore/clear; only the visible page owns image reads.
const thumbs = useHistoryThumbnails(
  () => visibleEntries.value.map(entry => ({ id: entry.id, image_id: entry.imageIds?.[0] })),
  () => true,
)

const emit = defineEmits<{
  (e: 'restore', id: string | number): void
  (e: 'clear'): void
  (e: 'reload'): void
}>()
</script>

<style scoped src="@/assets/css/gallery-trash.css"></style>
