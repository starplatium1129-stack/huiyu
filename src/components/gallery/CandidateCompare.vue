<template>
  <Teleport to="body"><dialog ref="dialog" class="candidate-compare" aria-labelledby="candidate-title" @click="onDialogClick" @close="emit('close')" @cancel.prevent="emit('close')">
    <header><div><h2 id="candidate-title">对比挑选</h2><p>并排看画面与参数，选出最满意的一张。暂不采用的图片仍然保留。</p></div><button class="btn btn-ghost btn-sm btn-icon" type="button" aria-label="关闭对比" @click="emit('close')"><ArchiveIcon name="close" /></button></header>
    <p v-if="error" class="candidate-error" role="alert">{{ error }}</p>
    <div class="candidate-grid"><article v-for="item in items" :key="item.id" :data-choice="item.reviewState || 'candidate'" class="candidate-card">
      <div class="candidate-image"><img :crossorigin="runtimeResourceCors()" v-if="urls[String(item.id)]" :src="resolveRuntimeUrl(urls[String(item.id)])" :alt="title(item)" /><span v-else>{{ loading ? '正在读取原图…' : '原图暂不可用，作品记录仍保留' }}</span></div>
      <div class="candidate-info"><h3>{{ title(item) }}</h3><p class="candidate-meta">{{ item.model || item.checkpoint || item.engine || '未记录模型' }}<br />{{ item.size || '未记录尺寸' }} · seed {{ item.seed ?? '随机' }}</p><strong class="candidate-verdict">{{ item.reviewState === 'preferred' ? '本组首选 · 已收藏' : item.reviewState === 'rejected' ? '暂不采用' : '候选' }}</strong>
      <div class="candidate-actions"><button class="btn btn-primary" type="button" :disabled="busy" @click="prefer(item)">选为首选</button><button class="btn btn-ghost" type="button" :disabled="busy" @click="setAside(item)">{{ item.reviewState === 'rejected' ? '恢复候选' : '暂不采用' }}</button><RouterLink class="btn btn-ghost" :to="`/prompt-builder?remix=${encodeURIComponent(item.id)}`" @click="emit('close')">继续微调</RouterLink></div></div>
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
.candidate-compare { margin: auto; width: min(1200px, calc(100vw - 28px)); max-height: calc(100dvh - 36px); padding: var(--s-5); border: 1px solid var(--border-soft); border-radius: var(--r-xl); background: var(--bg-surface); color: var(--text-primary); }
.candidate-compare[open] { display: flex; flex-direction: column; gap: var(--s-4); }
.candidate-compare::backdrop { background: var(--art-scrim); }
.candidate-compare header { display: flex; justify-content: space-between; gap: var(--s-3); }
.candidate-compare h2 { margin: 0; font-size: var(--fs-title-xs); }
.candidate-compare p, .candidate-compare footer { color: var(--text-secondary); font-size: var(--fs-label); line-height: var(--lh-body); }
.candidate-grid { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(250px, 1fr); gap: var(--s-3); min-height: 0; overflow: auto; scroll-snap-type: x proximity; }
.candidate-card { min-width: 0; padding: var(--s-3); border: 1px solid var(--border-soft); border-radius: var(--r-lg); background: var(--bg-deep); scroll-snap-align: start; }
.candidate-card[data-choice="preferred"] { border-color: var(--accent); background: var(--accent-soft); }
.candidate-image { display: flex; align-items: center; justify-content: center; height: min(48dvh, 480px); background: var(--bg-base); border-radius: var(--r-md); overflow: hidden; color: var(--text-muted); font-size: var(--fs-label); }
.candidate-image img { min-width: 0; min-height: 0; width: 100%; height: 100%; object-fit: contain; }
.candidate-info h3 { margin: var(--s-3) 0 var(--s-2); font-size: var(--fs-body-sm); overflow-wrap: anywhere; }
.candidate-meta { overflow-wrap: anywhere; }
.candidate-verdict { color: var(--accent); font-size: var(--fs-label); }
.candidate-actions { display: flex; flex-wrap: wrap; gap: var(--s-2); margin-top: var(--s-3); }
.candidate-compare .candidate-error { color: var(--warning-text); }
@media (max-width: 600px) { .candidate-compare { padding: var(--s-3); } .candidate-grid { grid-auto-columns: minmax(260px, 85vw); } }
@media (prefers-reduced-motion: reduce) { .candidate-compare[open] { animation: none; } }
</style>
