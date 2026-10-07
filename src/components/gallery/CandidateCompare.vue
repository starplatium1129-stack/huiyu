<template>
  <Teleport to="body"><dialog ref="dialog" class="candidate-compare" aria-labelledby="candidate-title" @click="onDialogClick" @close="emit('close')" @cancel.prevent="emit('close')">
    <header><div><h2 id="candidate-title">对比挑选</h2><p>并排看画面与参数，选出最满意的一张。暂不采用的图片仍然保留。</p></div><button class="btn btn-ghost btn-sm btn-icon" type="button" aria-label="关闭对比" @click="emit('close')"><ArchiveIcon name="close" /></button></header>
    <p v-if="error" class="candidate-error" role="alert">{{ error }}</p>
    <div class="candidate-controls" role="group" aria-label="候选对比设置">
      <button class="btn btn-ghost btn-sm" type="button" :aria-pressed="onlyDifferent" @click="onlyDifferent = !onlyDifferent">只看差异参数</button>
      <button class="btn btn-ghost btn-sm" type="button" :aria-pressed="synchronized" @click="toggleSync(candidates.map(item => item.id))">同步缩放与移动</button>
      <button class="btn btn-ghost btn-sm" type="button" @click="reset"><ArchiveIcon name="refresh" />复位全部画面</button>
      <span>滚轮缩放，放大后拖动画面；键盘加减、方向键和 Home 也可操作</span>
    </div>
    <div class="candidate-grid tw:grid tw:gap-s-3 tw:min-h-0 tw:overflow-auto"><article v-for="(item, index) in candidates" :key="item.id" :data-choice="item.reviewState || 'candidate'" class="candidate-card tw:min-w-0 tw:p-s-3 tw:rounded-lg">
      <CandidateViewport :src="urls[String(item.id)] || ''" :title="title(item)" :pose="poseFor(item.id)" :loading="loading" @change="update(item.id, $event)" />
      <div class="candidate-info"><h3>{{ title(item) }}</h3><p class="candidate-meta">{{ item.model || item.checkpoint || item.engine || '未记录模型' }}<br />{{ item.size || '未记录尺寸' }} · seed {{ item.seed ?? '随机' }}</p><strong class="candidate-verdict tw:text-accent tw:text-label">{{ item.reviewState === 'preferred' ? '本组首选 · 已收藏' : item.reviewState === 'rejected' ? '暂不采用' : '候选' }}</strong>
      <dl class="candidate-parameters" aria-label="候选参数"><div v-for="row in parameterRows" :key="row.key"><dt>{{ row.label }}</dt><dd>{{ row.values[index] }}</dd></div></dl>
      <p v-if="!parameterRows.length" class="candidate-meta">已记录参数没有差异</p>
      <div class="candidate-actions tw:flex tw:flex-wrap tw:gap-s-2 tw:mt-s-3"><button class="btn btn-primary" type="button" :disabled="busy" @click="prefer(item)">选为首选</button><button class="btn btn-ghost" type="button" :disabled="busy" @click="setAside(item)">{{ item.reviewState === 'rejected' ? '恢复候选' : '暂不采用' }}</button><RouterLink class="btn btn-ghost" :to="`/prompt-builder?remix=${encodeURIComponent(item.id)}`" @click="emit('close')">继续微调</RouterLink></div></div>
    </article></div>
    <footer>共 {{ candidates.length }} 张 · 标记自动保存到作品册 · 窄窗口可横向滚动</footer>
  </dialog></Teleport>
</template>
<script setup lang="ts">
import { computed, nextTick, onDeactivated, onUnmounted, ref, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import CandidateViewport from './CandidateViewport.vue'
import { sameArtworkMedia } from '@/composables/gallery/artworkMediaIdentity'
import { useCandidateMedia } from '@/composables/gallery/useCandidateMedia'
import { useCandidateViewport } from '@/composables/gallery/useCandidateViewport'
import { candidateParameterRows } from '@/composables/gallery/candidateParameters'

import { artworkRepository } from '@/storage/artworkRepository'
import type { ArtworkRecord } from '@/types/artwork'
import { useFluidDialog, isBackdropClick } from '@/composables/useFluidDialog'
const props = defineProps<{ open: boolean; items: ArtworkRecord[] }>()
const emit = defineEmits<{ close: []; changed: [] }>()
const dialog = ref<HTMLDialogElement | null>(null), busy = ref(false), error = ref(''), onlyDifferent = ref(true)
const motion = useFluidDialog(dialog)
const candidates = computed(() => props.items.slice(0, 4))
const { urls, loading, load, cancel, release } = useCandidateMedia()
const { synchronized, poseFor, update, toggleSync, reset } = useCandidateViewport()
const parameterRows = computed(() => candidateParameterRows(candidates.value, onlyDifferent.value))
let version = 0
const title = (item: ArtworkRecord) => item.sceneTitle || item.scene || '未命名作品'
function onDialogClick(event: MouseEvent) {
  if (isBackdropClick(event, dialog.value)) emit('close')
}
watch([() => props.open, () => candidates.value.map(({ id, image_id, image_url, image_data }) => ({ id, image_id, image_url, image_data }))], async ([open, items], [previousOpen, previousItems]) => {
  if (open === previousOpen && previousItems?.length === items.length
    && items.every((item, index) => sameArtworkMedia(item, previousItems[index]))) return
  const current = ++version
  if (!open) { cancel(); motion.close(release); return }
  release(); reset(); error.value = ''
  await nextTick()
  if (!props.open || current !== version) return
  motion.open(); load(candidates.value)
}, { immediate: true })
async function save(patches: Array<{ id: string | number; patch: Partial<ArtworkRecord> }>) {
  if (busy.value) return
  const current = version
  busy.value = true; error.value = ''
  try { await artworkRepository.patchArtworks(patches); emit('changed') }
  catch { if (props.open && current === version) error.value = '标记没有保存成功，请重试；图片没有被删除。' }
  finally { busy.value = false }
}
function prefer(item: ArtworkRecord) { return save(candidates.value.map(candidate => ({ id: candidate.id, patch: candidate.id === item.id ? { reviewState: 'preferred', favorite: true } : candidate.reviewState === 'preferred' ? { reviewState: 'candidate' } : {} }))) }
function setAside(item: ArtworkRecord) { return save([{ id: item.id, patch: item.reviewState === 'rejected' ? { reviewState: 'candidate' } : { reviewState: 'rejected', favorite: false } }]) }
onDeactivated(() => { version++; emit('close'); dialog.value?.close(); release() })
onUnmounted(() => { version++; release() })
</script>
<style scoped>
@reference "../../assets/css/tailwind.css";
.candidate-compare { @apply tw:m-auto; width: min(1680px, calc(100vw - 28px)); max-height: calc(100dvh - 36px); @apply tw:p-s-5; border: 1px solid var(--border-soft); @apply tw:rounded-xl; background: var(--bg-surface); @apply tw:text-primary; }
.candidate-compare[open] { @apply tw:flex tw:flex-col tw:gap-s-4; }
.candidate-compare::backdrop { background: var(--art-scrim); }
.candidate-compare header { @apply tw:flex tw:justify-between tw:gap-s-3; }
.candidate-compare h2 { @apply tw:m-0 tw:text-title-xs; }
.candidate-compare p, .candidate-compare footer { @apply tw:text-secondary tw:text-label tw:leading-body; }
.candidate-grid { grid-auto-flow: column; grid-auto-columns: minmax(250px, 1fr); scroll-snap-type: x proximity; }
.candidate-card { border: 1px solid var(--border-soft); background: var(--bg-deep); scroll-snap-align: start; }
.candidate-card[data-choice="preferred"] { @apply tw:border-accent; background: var(--accent-soft); }
.candidate-info h3 { margin: var(--s-3) 0 var(--s-2); @apply tw:text-body-sm; overflow-wrap: anywhere; }
.candidate-meta { overflow-wrap: anywhere; }
.candidate-controls { @apply tw:flex tw:flex-wrap tw:items-center tw:gap-s-2; }
.candidate-controls > span { @apply tw:text-secondary tw:text-label-sm; }
.candidate-controls [aria-pressed="true"] { @apply tw:text-accent tw:border-accent; }
.candidate-parameters { @apply tw:grid tw:gap-s-1 tw:text-label-sm; margin:var(--s-3) 0; }
.candidate-parameters > div { display:grid; grid-template-columns:5.5rem minmax(0,1fr); gap:var(--s-2); }
.candidate-parameters dt { @apply tw:text-secondary; }
.candidate-parameters dd { @apply tw:m-0 tw:text-primary; overflow-wrap:anywhere; max-height:5lh; overflow:auto; }
.candidate-compare .candidate-error { @apply tw:text-warning-text; }
@media (max-width: 600px) { .candidate-compare { @apply tw:p-s-3; } .candidate-grid { grid-auto-columns: minmax(260px, 85vw); } }
@media (prefers-reduced-motion: reduce) { .candidate-compare[open] { animation: none; } }
</style>
