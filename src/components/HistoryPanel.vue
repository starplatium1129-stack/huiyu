<template>
  <section class="history-wrap" aria-label="作品历史">
    <div class="panel-title history-head">
      <span>最近作品</span>
      <span v-if="selectedEntries.length" class="history-batch">
        <button class="history-action primary" type="button" @click="$emit('to-shots-batch', selectedEntries)">
          加入分镜 ({{ selectedEntries.length }})
        </button>
        <button class="history-action" type="button" @click="selectedSet.clear()">取消选择</button>
      </span>
    </div>
    <div v-if="!items.length" class="history-empty">
      <ArchiveIcon name="image" class="history-empty-icon" />
      <span>还没有保存的作品。生成后点“存入作品册”，把喜欢的这一刻留在这里。</span>
    </div>
    <div v-else class="history-list compact-history-list">
      <article v-for="item in items" :key="item.id" class="history-item" :data-selected="selectedSet.has(item.id) || undefined">
        <div class="history-thumb">
          <img :crossorigin="runtimeResourceCors()" v-if="thumbs[item.id]" :src="resolveRuntimeUrl(thumbs[item.id])" alt="历史作品缩略图" loading="lazy">
          <img :crossorigin="runtimeResourceCors()" v-else class="history-placeholder" :src="resolveRuntimeUrl(placeholderUrl)" alt="" aria-hidden="true">
          <span class="history-thumb-badge">v{{ item.version || 1 }}</span>
          <StudioTooltip content="勾选后可批量加入分镜">
            <label class="history-pick tw:absolute tw:top-[6px] tw:left-[6px] tw:inline-flex tw:items-center tw:justify-center tw:cursor-pointer">
              <input v-model="selectedSet" type="checkbox" :value="item.id" :aria-label="'选择作品：' + (item.sceneTitle || item.story || item.id)" class="history-pick-input tw:absolute tw:w-[1px] tw:h-[1px] tw:pointer-events-none" />
              <span class="history-pick-box tw:grid tw:w-[20px] tw:h-[20px] tw:rounded-sm" aria-hidden="true">
                <ArchiveIcon name="success" class="history-pick-check" />
              </span>
            </label>
          </StudioTooltip>
        </div>
        <div class="history-main">
          <div class="history-card-title">{{ item.sceneTitle || item.story || '未命名作品' }}</div>
          <div class="history-meta">
            <span v-if="item.engine === 'anima' && item.preview" class="history-preview-badge">实验预览</span>
            <span v-if="item.engine === 'anima' || item.engine === 'krea2'" class="history-engine">{{ engineSummary(item) }}</span>
            <span class="primary">seed {{ item.seed ?? -1 }}</span>
            <span class="sep">·</span>
            <span>{{ item.size || '未记录尺寸' }}</span>
          </div>
          <div class="history-side">
            <span v-if="item.favorite" class="history-rating favorite">
              <ArchiveIcon name="love" />
            </span>
            <div class="history-actions" aria-label="历史操作">
              <button class="history-action primary" type="button" @click="$emit('resume', item)">继续</button>
              <StudioTooltip content="把这张图加入分镜短片待带入列表">
              <button class="history-action" type="button" aria-label="加入分镜" @click="$emit('to-shots', item)"><ArchiveIcon name="gallery" /></button>
              </StudioTooltip>
              <StudioTooltip content="复制配方"><button class="history-action" type="button" aria-label="复制配方" @click="$emit('duplicate', item)"><ArchiveIcon name="copy" /></button></StudioTooltip>
              <StudioTooltip content="删除历史"><button class="history-action delete" type="button" aria-label="删除历史" @click="$emit('delete', item)"><ArchiveIcon name="close" /></button></StudioTooltip>
            </div>
          </div>
        </div>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { resolveRuntimeUrl, runtimeResourceCors } from '@/platform/runtimeUrl'

import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { artworkRepository } from '@/storage/artworkRepository'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import { artworkTimestamp } from '@/types/artwork'
import type { ArtworkRecord } from '@/types/artwork'
import { useSceneStore } from '@/stores/sceneStore'
import '@/assets/css/director/components/HistoryPanel.css'

// 与 config/characters.ts 共用 Express 服务的同一份立绘 URL，避免 Vite 打包副本
const placeholderUrl = '/assets/characters/nene-official.webp'
const sceneStore = useSceneStore()

const props = defineProps<{ history: ArtworkRecord[] }>()
defineEmits<{
  resume: [entry: ArtworkRecord]
  duplicate: [entry: ArtworkRecord]
  delete: [entry: ArtworkRecord]
  'to-shots': [entry: ArtworkRecord]
  'to-shots-batch': [entries: ArtworkRecord[]]
}>()

// 必须用 ref 而非 reactive/const 裸 Set：checkbox 的 v-model 在选中变化时会整体赋值
// （Vue 运行时先对 Set 做 add/delete，再 assign 回绑定）。裸 const 会编译成
// `selectedSet = $event` 并在运行时抛 TypeError（esbuild 构建期即告警）。
const selectedSet = ref(new Set<string | number>())
const selectedEntries = computed(() =>
  props.history.filter(entry => selectedSet.value.has(entry.id)))

const thumbs = reactive<Record<string | number, string>>({})
const thumbnailRequests = new Map<string | number, { imageId: string }>()
let disposed = false
const items = computed(() => props.history.slice().sort((a, b) => artworkTimestamp(b) - artworkTimestamp(a)).slice(0, 12))

function engineSummary(item: ArtworkRecord): string {
  const engineName = item.engine === 'krea2' ? 'Krea 2' : 'Anima'
  if (item.subject === 'popular' || item.characterId) {
    const popChar = sceneStore.popularCharacters.find(c => c.id === (item.characterId || item.character))
    return `${engineName} · ${popChar?.displayName || '热门角色'}`
  }
  const charLabel = item.character === 'natsume' ? '夏目' : item.character === 'triad' ? '宁宁与夏目' : '宁宁'
  return `${engineName} · ${charLabel}`
}

function releaseThumb(id: string | number) {
  if (thumbs[id]) URL.revokeObjectURL(thumbs[id])
  delete thumbs[id]
  thumbnailRequests.delete(id)
}

async function ensureThumb(id: string | number, request: { imageId: string }) {
  try {
    const blob = await artworkRepository.getImage(request.imageId)
    if (disposed || thumbnailRequests.get(id) !== request) return
    if (blob) thumbs[id] = URL.createObjectURL(blob)
    else thumbnailRequests.delete(id)
  } catch (e) {
    if (!disposed && thumbnailRequests.get(id) === request) {
      thumbnailRequests.delete(id)
      console.warn('history thumb load failed', e)
    }
  }
}

watch(() => items.value.map(item => [item.id, item.image_id] as const), next => {
  const visible = new Map(next)
  for (const [id, request] of thumbnailRequests) {
    if (visible.get(id) !== request.imageId) releaseThumb(id)
  }
  for (const [id, imageId] of next) {
    if (!imageId || thumbnailRequests.has(id)) continue
    const request = { imageId }
    thumbnailRequests.set(id, request)
    void ensureThumb(id, request)
  }
}, { immediate: true })

onBeforeUnmount(() => {
  disposed = true
  for (const id of thumbnailRequests.keys()) releaseThumb(id)
})

</script>

<style scoped>
@reference "../assets/css/tailwind.css";
.history-head { @apply tw:flex tw:items-center tw:justify-between tw:gap-s-2; }
.history-empty {
  @apply tw:flex tw:flex-col tw:items-center tw:justify-center tw:gap-s-2;
  padding: var(--s-5) var(--s-4);
  @apply tw:text-muted tw:text-center tw:text-label-sm;
  background: color-mix(in srgb, var(--bg-deep) 60%, transparent);
  border: 1px dashed var(--border-soft);
  @apply tw:rounded-md;
}
.history-empty-icon {
  @apply tw:text-title;
  color: var(--archive-blue);
  opacity: 0.7;
}
.history-batch { @apply tw:inline-flex tw:gap-s-1; }
.history-pick {
  z-index: 2;
}
.history-pick-input { opacity: 0;
}
.history-pick-box { place-items: center;
  background: color-mix(in srgb, var(--bg-surface) 82%, transparent);
  border: 1px solid var(--border-strong);
  color: transparent;
  backdrop-filter: blur(8px);
  box-shadow: 0 1px 4px var(--art-scrim-soft);
  transition: border-color var(--motion-hover) var(--ease-out), background var(--motion-hover) var(--ease-out), color var(--motion-hover) var(--ease-out);
}
.history-pick:hover .history-pick-box {
  @apply tw:border-accent;
  background: color-mix(in srgb, var(--accent-soft) 60%, var(--bg-surface));
}
.history-pick-input:checked + .history-pick-box {
  background: var(--accent);
  @apply tw:border-accent tw:text-inverse;
  box-shadow: 0 0 10px -1px var(--accent-glow);
}
.history-pick-input:focus-visible + .history-pick-box {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.history-pick-check {
  @apply tw:w-[13px] tw:h-[13px];
}
.history-item[data-selected="true"] { outline: 1px solid var(--accent); outline-offset: -1px; @apply tw:rounded-md; }
.history-thumb { @apply tw:relative; }
</style>
