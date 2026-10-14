<template>
  <figure v-if="scene" class="scene-reference" :class="{ 'is-unconnected': !loading && !entry }" :style="{ '--reference-image-ratio': imageRatio && !failed ? String(imageRatio) : undefined }" aria-label="当前场景参考">
    <div class="scene-reference-picture tw:relative tw:overflow-hidden tw:grid tw:rounded-lg" :class="{ 'is-restricted': restricted }">
      <img v-if="image.src && !failed" v-bind="image" :alt="restricted ? '' : `${scene.title}的场景参考样张`" decoding="async" />
      <div v-else class="scene-reference-empty tw:grid tw:gap-s-3 tw:p-s-4 tw:text-secondary tw:text-label tw:text-center"><ArchiveIcon name="image" /><span>{{ loading ? '正在核对参考样张…' : !entry || failed ? '这一幕暂未提供可核实的样张' : '分级参考已遮挡' }}</span></div>
      <span v-if="restricted && canLoad && !failed" class="scene-reference-mask tw:absolute tw:grid tw:text-primary tw:text-label">分级参考 · 已模糊</span>
    </div>
    <figcaption>
      <span class="scene-reference-label tw:block tw:mb-s-2 tw:text-secondary tw:text-label">场景参考 · 非本次生成</span>
      <strong>{{ scene.title }}</strong>
      <p>用于观察场景氛围。实际画面以当前角色、造型与生成设置为准。</p>
      <dl class="scene-reference-settings tw:flex tw:flex-wrap tw:m-0 tw:text-label">
        <div><dt>镜头</dt><dd>{{ shot }}</dd></div>
        <div><dt>构图</dt><dd>{{ composition }}</dd></div>
        <div><dt>光照</dt><dd>{{ lighting }}</dd></div>
        <div v-if="size"><dt>画幅</dt><dd>{{ size }}</dd></div>
      </dl>
    </figcaption>
  </figure>
</template>

<script setup lang="ts">
import { useRuntimeImage } from '@/composables/useRuntimeImage'

import { runtimeFetch, runtimeResourceIdentity } from '@/platform/runtimeUrl'

import { computed, ref, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import { COMPOSITION, LIGHTING, SHOT } from '@/config/promptConstants'
import { parseShowcaseManifest, type ShowcaseEntry } from '@/utils/showcaseManifest'

defineProps<{ size?: string }>()
const pb = usePromptBuilderStore()
const loading = ref(true)
const entries = ref<ShowcaseEntry[]>([])
watch(runtimeResourceIdentity, async (_identity, _previous, cleanup) => {
  const controller = new AbortController()
  cleanup(() => controller.abort())
  entries.value = []; loading.value = true
  try {
    const response = await runtimeFetch('/scene-showcase/manifest.json', { signal: controller.signal, cache: 'no-cache' })
    if (!response.ok) return
    const raw = await response.json() as { entries?: Array<{ id?: unknown } | null> }
    if (!Array.isArray(raw.entries)) return
    const counts = new Map<unknown, number>()
    for (const item of raw.entries) counts.set(item?.id, (counts.get(item?.id) ?? 0) + 1)
    if (!controller.signal.aborted) entries.value = parseShowcaseManifest(raw).entries.filter(item => counts.get(item.id) === 1)
  } catch { /* Unverified references stay closed; drafting remains available. */ }
  finally { if (!controller.signal.aborted) loading.value = false }
}, { immediate: true })
const scene = computed(() => {
  const subject = pb.subject
  if (subject.kind === 'popular') {
    const blueprint = pb.sceneBlueprints.find(item => item.id === subject.blueprintId && item.characterId === subject.characterId)
    return blueprint ? { title: blueprint.title, id: `pc_${subject.characterId}_${blueprint.id}`, rating: blueprint.adult ? 'R18' : blueprint.sampleRating } : null
  }
  return pb.activeScene ? { title: pb.activeScene.title, id: pb.activeScene.id, rating: pb.activeScene.mature ? 'R18' : pb.activeScene.rating } : null
})
const entry = computed(() => entries.value.find(item => item.id === scene.value?.id && (item.type === 'scene' || item.type === 'popular')))
const restricted = computed(() => entry.value?.rating === 'R18' || scene.value?.rating === 'R18')
const imageUrl = computed(() => {
  if (!entry.value) return ''
  const path = entry.value.thumb || `thumbs/${entry.value.id}.jpg`
  return /^(?:thumbs|images)\/[a-zA-Z0-9_-]+\.(?:jpg|jpeg|png|webp)$/.test(path) ? `/scene-showcase/${path}` : ''
})
const canLoad = computed(() => !!imageUrl.value)
const { image: runtimeImage, src, failed } = useRuntimeImage(() => canLoad.value ? imageUrl.value : '')
const imageRatio = ref<number | null>(null)
watch([src, runtimeResourceIdentity], () => { imageRatio.value = null }, { flush: 'sync' })
function measureImage(event: Event) {
  if (!runtimeImage.value.onLoad(event)) return
  const image = event.target as HTMLImageElement
  imageRatio.value = image.naturalWidth / image.naturalHeight
}
const image = computed(() => ({ ...runtimeImage.value, onLoad: measureImage }))
const shot = computed(() => SHOT.find(item => item.id === pb.selections.shot)?.name ?? '跟随场景')
const composition = computed(() => COMPOSITION.find(item => item.id === pb.selections.composition)?.name ?? '跟随场景')
const lighting = computed(() => LIGHTING.find(item => item.id === pb.selections.lighting)?.name ?? '跟随场景')
</script>

<style scoped>
.scene-reference { display:flex; flex-direction:column; align-items:center; gap:20px; margin:0; min-height:0; width:100%; text-align:center; }
.scene-reference-picture { position:relative; width:100%; flex:1; min-height:0; overflow:hidden; display:grid; place-items:center; background:transparent; }
.scene-reference-picture img { position:absolute; inset:0; width:100%; height:100%; object-fit:contain; }
.scene-reference-picture.is-restricted img { filter:blur(24px); transform:scale(1.15); }
.scene-reference-mask { inset:0; place-items:center; background:var(--art-scrim); color:var(--on-art-primary); }
.scene-reference-empty { display:grid; justify-items:center; align-content:center; gap:20px; height:100%; font-size:14px; line-height:1.7; color:var(--text-primary); }
.scene-reference-empty .archive-icon { width:32px; height:32px; }
figcaption { flex:none; max-width:100%; }
figcaption strong { display:none; }
.scene-reference-label { color:var(--text-secondary); font-size:11px; }
figcaption p { margin:8px 0 12px; color:var(--text-secondary); font-size:12px; line-height:1.7; }
.scene-reference-settings { display:flex; flex-wrap:wrap; justify-content:center; gap:12px 24px; margin:0; font-size:12px; }
.scene-reference-settings dt { color:var(--text-secondary); }
.scene-reference-settings dd { color:var(--text-primary); margin:4px 0 0; }
@container canvas-column (max-width:440px) { .scene-reference-settings { gap:8px; } }
</style>
