<template>
  <section class="history-wrap" aria-label="作品历史">
    <div class="panel-title history-head">
      <span>历史 · History</span>
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
          <img v-if="thumbs[item.id]" :src="thumbs[item.id]" alt="历史作品缩略图" loading="lazy">
          <img v-else class="history-placeholder" :src="placeholderUrl" alt="" aria-hidden="true">
          <span class="history-thumb-badge">v{{ item.version || 1 }}</span>
          <label class="history-pick" title="勾选后可批量加入分镜">
            <input v-model="selectedSet" type="checkbox" :value="item.id" />
          </label>
        </div>
        <div class="history-main">
          <div class="history-card-title">{{ item.sceneTitle || item.story || '未命名作品' }}</div>
          <p class="history-text">{{ item.prompt }}</p>
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
              <button class="history-action" type="button" title="把这张图加入分镜短片待带入列表" @click="$emit('to-shots', item)">加入分镜</button>
              <button class="history-action" type="button" @click="$emit('duplicate', item)">复制</button>
              <button class="history-action delete" type="button" aria-label="删除历史" @click="$emit('delete', item)">×</button>
            </div>
          </div>
        </div>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { imgGet } from '@/composables/useImageStore'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
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
const objectUrls = new Map<string | number, string>()
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

async function ensureThumb(item: ArtworkRecord) {
  if (!item.image_id || thumbs[item.id] || objectUrls.has(item.id)) return
  try {
    const blob = await imgGet(item.image_id)
    if (!blob) return
    const url = URL.createObjectURL(blob)
    objectUrls.set(item.id, url)
    thumbs[item.id] = url
  } catch (e) {
    console.warn('history thumb load failed', e)
  }
}

watch(items, next => { next.forEach(item => ensureThumb(item)) }, { immediate: true })

onBeforeUnmount(() => {
  objectUrls.forEach(url => URL.revokeObjectURL(url))
  objectUrls.clear()
})
</script>

<style scoped>
.history-head { display: flex; align-items: center; justify-content: space-between; gap: var(--s-2); }
.history-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--s-2);
  padding: var(--s-5) var(--s-4);
  color: var(--text-muted);
  text-align: center;
  font-size: var(--fs-label-sm);
  background: color-mix(in srgb, var(--bg-deep) 60%, transparent);
  border: 1px dashed var(--border-soft);
  border-radius: var(--r-md);
}
.history-empty-icon {
  font-size: var(--fs-title);
  color: var(--archive-blue);
  opacity: 0.7;
}
.history-batch { display: inline-flex; gap: var(--s-1); }
.history-pick {
  position: absolute; top: 4px; left: 4px;
  display: grid; place-items: center;
  width: 20px; height: 20px;
  border-radius: var(--r-sm);
  background: color-mix(in srgb, var(--bg-deep) 78%, transparent);
  cursor: pointer;
}
.history-pick input { margin: 0; accent-color: var(--accent); }
.history-item[data-selected="true"] { outline: 1px solid var(--accent); outline-offset: -1px; border-radius: var(--r-md); }
.history-thumb { position: relative; }
</style>
