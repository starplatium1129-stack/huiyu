<template>
  <Teleport to="body"><dialog ref="dialog" class="candidate-compare" aria-labelledby="candidate-title" @click="onDialogClick" @close="emit('close')" @cancel.prevent="emit('close')">
    <header><div><h2 id="candidate-title">对比挑选</h2><p>并排看画面与参数，选出最满意的一张。暂不采用的图片仍然保留。</p></div><button class="btn btn-ghost btn-sm btn-icon" type="button" aria-label="关闭对比" @click="emit('close')"><ArchiveIcon name="close" /></button></header>
    <p v-if="error" class="candidate-error" role="alert">{{ error }}</p>
    <div class="candidate-grid tw:grid tw:gap-s-3 tw:min-h-0 tw:overflow-auto"><article v-for="item in items" :key="item.id" :data-choice="item.reviewState || 'candidate'" class="candidate-card tw:min-w-0 tw:p-s-3 tw:rounded-lg">
      <div class="candidate-image tw:flex tw:items-center tw:justify-center tw:rounded-md tw:overflow-hidden tw:text-muted tw:text-label"><img :crossorigin="runtimeResourceCors()" v-if="urls[String(item.id)]" :src="resolveRuntimeUrl(urls[String(item.id)])" :alt="title(item)" /><span v-else>{{ loading ? '正在读取原图…' : '原图暂不可用，作品记录仍保留' }}</span></div>
      <div class="candidate-info"><h3>{{ title(item) }}</h3><p class="candidate-meta">{{ item.model || item.checkpoint || item.engine || '未记录模型' }}<br />{{ item.size || '未记录尺寸' }} · seed {{ item.seed ?? '随机' }}</p><strong class="candidate-verdict tw:text-accent tw:text-label">{{ item.reviewState === 'preferred' ? '本组首选 · 已收藏' : item.reviewState === 'rejected' ? '暂不采用' : '候选' }}</strong>
      <div class="candidate-actions tw:flex tw:flex-wrap tw:gap-s-2 tw:mt-s-3"><button class="btn btn-primary" type="button" :disabled="busy" @click="prefer(item)">选为首选</button><button class="btn btn-ghost" type="button" :disabled="busy" @click="setAside(item)">{{ item.reviewState === 'rejected' ? '恢复候选' : '暂不采用' }}</button><RouterLink class="btn btn-ghost" :to="`/prompt-builder?remix=${encodeURIComponent(item.id)}`" @click="emit('close')">继续微调</RouterLink></div></div>
    </article></div>
    <footer>共 {{ items.length }} 张 · 标记自动保存到作品册 · 窄屏可横向滑动</footer>
  </dialog></Teleport>
</template>
<script setup lang="ts">
import { resolveRuntimeUrl, runtimeResourceCors } from '@/platform/runtimeUrl'

import { nextTick, onDeactivated, onUnmounted, ref, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'

import { artworkRepository } from '@/storage/artworkRepository'
import type { ArtworkRecord } from '@/types/artwork'
import { useFluidDialog, isBackdropClick } from '@/composables/useFluidDialog'
const props = defineProps<{ open: boolean; items: ArtworkRecord[] }>()
const emit = defineEmits<{ close: []; changed: [] }>()
const dialog = ref<HTMLDialogElement | null>(null), urls = ref<Record<string, string>>({}), busy = ref(false), loading = ref(false), error = ref('')
const motion = useFluidDialog(dialog)
const owned = new Set<string>()
let version = 0
const title = (item: ArtworkRecord) => item.sceneTitle || item.scene || '未命名作品'
function onDialogClick(event: MouseEvent) {
  if (isBackdropClick(event, dialog.value)) emit('close')
}
function release() { version++; for (const url of owned) URL.revokeObjectURL(url); owned.clear(); urls.value = {} }
watch(() => props.open, async open => {
  if (!open) { motion.close(release); return }
  release(); error.value = ''; await nextTick()
  if (!props.open) return
  motion.open(); loading.value = true
  const current = version
  await Promise.all(props.items.map(async item => {
    try {
      const blob = item.image_id ? await artworkRepository.getImage(item.image_id) : null
      if (current !== version) return
      if (blob) { const url = URL.createObjectURL(blob); owned.add(url); urls.value[String(item.id)] = url }
      else {
        const fallback = String(item.image_data || item.image_url || '')
        if (/^(data:image\/|blob:|\/(?!\/))/.test(fallback)) urls.value[String(item.id)] = fallback
      }
    } catch { /* Each unavailable image keeps its own recovery placeholder. */ }
  }))
  if (current === version) loading.value = false
}, { immediate: true })
async function save(patches: Array<{ id: string | number; patch: Partial<ArtworkRecord> }>) {
  if (busy.value) return
  busy.value = true; error.value = ''
  try { await artworkRepository.patchArtworks(patches); emit('changed') }
  catch { error.value = '标记没有保存成功，请重试；图片没有被删除。' }
  finally { busy.value = false }
}
function prefer(item: ArtworkRecord) { return save(props.items.map(candidate => ({ id: candidate.id, patch: candidate.id === item.id ? { reviewState: 'preferred', favorite: true } : candidate.reviewState === 'preferred' ? { reviewState: 'candidate' } : {} }))) }
function setAside(item: ArtworkRecord) { return save([{ id: item.id, patch: item.reviewState === 'rejected' ? { reviewState: 'candidate' } : { reviewState: 'rejected', favorite: false } }]) }
onDeactivated(() => { emit('close'); dialog.value?.close(); release() })
onUnmounted(release)
</script>
<style scoped>
@reference "../../assets/css/tailwind.css";
.candidate-compare { @apply tw:m-auto; width: min(1200px, calc(100vw - 28px)); max-height: calc(100dvh - 36px); @apply tw:p-s-5; border: 1px solid var(--border-soft); @apply tw:rounded-xl; background: var(--bg-surface); @apply tw:text-primary; }
.candidate-compare[open] { @apply tw:flex tw:flex-col tw:gap-s-4; }
.candidate-compare::backdrop { background: var(--art-scrim); }
.candidate-compare header { @apply tw:flex tw:justify-between tw:gap-s-3; }
.candidate-compare h2 { @apply tw:m-0 tw:text-title-xs; }
.candidate-compare p, .candidate-compare footer { @apply tw:text-secondary tw:text-label tw:leading-body; }
.candidate-grid { grid-auto-flow: column; grid-auto-columns: minmax(250px, 1fr); scroll-snap-type: x proximity; }
.candidate-card { border: 1px solid var(--border-soft); background: var(--bg-deep); scroll-snap-align: start; }
.candidate-card[data-choice="preferred"] { @apply tw:border-accent; background: var(--accent-soft); }
.candidate-image { height: min(48dvh, 480px); background: var(--bg-base); }
.candidate-image img { @apply tw:min-w-0 tw:min-h-0 tw:w-full tw:h-full tw:object-contain; }
.candidate-info h3 { margin: var(--s-3) 0 var(--s-2); @apply tw:text-body-sm; overflow-wrap: anywhere; }
.candidate-meta { overflow-wrap: anywhere; }
.candidate-compare .candidate-error { @apply tw:text-warning-text; }
@media (max-width: 600px) { .candidate-compare { @apply tw:p-s-3; } .candidate-grid { grid-auto-columns: minmax(260px, 85vw); } }
@media (prefers-reduced-motion: reduce) { .candidate-compare[open] { animation: none; } }
</style>
