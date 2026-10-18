<template>
  <section class="history-wrap" aria-label="作品历史">
    <div class="history-head">
      <h3 class="panel-title">最近作品</h3>
      <span v-if="selectedEntries.length" class="history-batch" role="group" aria-label="已选作品操作">
        <button class="btn btn-primary btn-sm" type="button" :disabled="transferBusy" :aria-busy="transferBusy" @click="$emit('to-shots-batch', selectedEntries)">
          <ArchiveIcon name="gallery" />加入分镜 ({{ selectedEntries.length }})
        </button>
        <button class="btn btn-quiet btn-sm" type="button" @click="selectedSet.clear()">取消选择</button>
      </span>
    </div>
    <div v-if="!items.length" class="history-empty" role="status">
      <ArchiveIcon name="image" class="history-empty-icon" />
      <span>还没有保存的作品。生成后点“存入作品册”，把喜欢的这一刻留在这里。</span>
    </div>
    <div v-else class="history-list">
      <article v-for="item in items" :key="item.id" class="history-item" :data-selected="selectedSet.has(item.id) || undefined">
        <div class="history-thumb">
          <img :crossorigin="runtimeResourceCors()" v-if="thumbs[item.id]" :src="resolveRuntimeUrl(thumbs[item.id])" alt="历史作品缩略图" loading="lazy">
          <div v-else class="history-placeholder"><ArchiveIcon name="image" /><span>暂未载入预览</span></div>
          <span class="history-thumb-badge">v{{ item.version || 1 }}</span>
          <StudioCheckbox class="history-pick" :checked="selectedSet.has(item.id)"
            :label="'选择作品：' + (item.sceneTitle || item.story || item.id)"
            @update:checked="setSelected(item.id, $event)" />
        </div>
        <div class="history-main">
          <div class="history-card-title">{{ item.sceneTitle || item.story || '未命名作品' }}</div>
          <div class="history-meta">
            <span v-if="item.engine === 'anima' && item.preview" class="history-preview-badge">实验预览</span>
            <span v-if="item.engine === 'anima' || item.engine === 'krea2'">{{ engineSummary(item) }}</span>
            <span class="history-seed">Seed {{ item.seed ?? -1 }}</span>
            <span aria-hidden="true">·</span>
            <span>{{ item.size || '未记录尺寸' }}</span>
          </div>
          <div class="history-side">
            <span v-if="item.favorite" class="history-favorite" role="img" aria-label="已收藏">
              <ArchiveIcon name="love" />
            </span>
            <div class="history-actions" role="group" aria-label="历史操作">
              <button class="btn btn-ghost btn-sm" type="button" @click="$emit('resume', item)">继续</button>
              <StudioTooltip content="把这张图加入分镜短片待带入列表">
              <button class="btn btn-quiet btn-icon btn-sm" type="button" aria-label="加入分镜" :disabled="transferBusy" :aria-busy="transferBusy" @click="$emit('to-shots', item)"><ArchiveIcon name="gallery" /></button>
              </StudioTooltip>
              <StudioTooltip content="复制配方"><button class="btn btn-quiet btn-icon btn-sm" type="button" aria-label="复制配方" @click="$emit('duplicate', item)"><ArchiveIcon name="copy" /></button></StudioTooltip>
              <StudioTooltip content="删除历史"><button class="btn btn-danger btn-icon btn-sm" type="button" aria-label="删除历史" @click="$emit('delete', item)"><ArchiveIcon name="close" /></button></StudioTooltip>
            </div>
          </div>
        </div>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { resolveRuntimeUrl, runtimeResourceCors } from '@/platform/runtimeUrl'

import { computed, ref } from 'vue'
import { useHistoryThumbnails } from '@/composables/prompt/useHistoryThumbnails'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import StudioCheckbox from '@/components/ui/StudioCheckbox.vue'
import { artworkTimestamp } from '@/types/artwork'
import type { ArtworkRecord } from '@/types/artwork'
import { useSceneStore } from '@/stores/sceneStore'

const sceneStore = useSceneStore()

const props = defineProps<{ history: ArtworkRecord[]; active: boolean; transferBusy: boolean }>()
defineEmits<{
  resume: [entry: ArtworkRecord]
  duplicate: [entry: ArtworkRecord]
  delete: [entry: ArtworkRecord]
  'to-shots': [entry: ArtworkRecord]
  'to-shots-batch': [entries: ArtworkRecord[]]
}>()

const selectedSet = ref(new Set<string | number>())
function setSelected(id: ArtworkRecord['id'], checked: boolean) {
  if (checked) selectedSet.value.add(id)
  else selectedSet.value.delete(id)
}
const selectedEntries = computed(() =>
  props.history.filter(entry => selectedSet.value.has(entry.id)))

const items = computed(() => props.history.slice().sort((a, b) => artworkTimestamp(b) - artworkTimestamp(a)).slice(0, 12))
const thumbs = useHistoryThumbnails(() => items.value, () => props.active)

function engineSummary(item: ArtworkRecord): string {
  const engineName = item.engine === 'krea2' ? 'Krea 2' : 'Anima'
  if (item.subject === 'popular' || item.characterId) {
    const popChar = sceneStore.popularCharacters.find(c => c.id === (item.characterId || item.character))
    return `${engineName} · ${popChar?.displayName || '热门角色'}`
  }
  const charLabel = item.character === 'natsume' ? '夏目' : item.character === 'triad' ? '宁宁与夏目' : '宁宁'
  return `${engineName} · ${charLabel}`
}

</script>

<style scoped src="@/assets/css/director/components/HistoryPanel.css"></style>
