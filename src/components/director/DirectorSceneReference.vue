<template>
  <figure v-if="scene" class="scene-reference" :class="{ 'is-unconnected': !loading && !entry }" :style="{ '--reference-image-ratio': imageRatio && !failed ? String(imageRatio) : undefined }" aria-label="当前场景参考">
    <div class="scene-reference-picture tw:relative tw:overflow-hidden tw:grid tw:rounded-lg" :class="{ 'is-restricted': restricted }">
      <img v-if="image.src && !failed" v-bind="image" :alt="restricted ? '' : `${scene.title}的场景参考样张`" decoding="async" />
      <div v-else class="scene-reference-empty tw:grid tw:gap-s-3 tw:p-s-4 tw:text-body tw:text-center"><ArchiveIcon name="image" /><span>{{ loading ? '核对样张中…' : !entry || failed ? '暂无参考样张' : '已遮挡' }}</span></div>
      <span v-if="restricted && canLoad && !failed" class="scene-reference-mask tw:absolute tw:grid tw:text-primary tw:text-label">分级参考 · 已模糊</span>
    </div>
    <figcaption>
      <span class="scene-reference-label tw:block tw:mb-s-2 tw:text-secondary tw:text-label-xs">场景参考</span>
      <strong>{{ scene.title }}</strong>
      <p>观察场景氛围，出图以当前设置为准。</p>
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
import { runtimeResourceIdentity } from '@/platform/runtimeUrl'
import { computed, onActivated, onDeactivated, ref, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import { COMPOSITION, LIGHTING, SHOT } from '@/config/promptConstants'
import { catalogShowcaseId } from '@/utils/showcaseManifest'
import { useShowcaseAssets } from '@/composables/scene/useShowcaseAssets'

defineProps<{ size?: string }>()
const pb = usePromptBuilderStore()
const attached = ref(true)
onActivated(() => { attached.value = true })
onDeactivated(() => { attached.value = false })
const scene = computed(() => {
  const subject = pb.subject
  if (subject.kind === 'popular') {
    const blueprint = pb.sceneBlueprints.find(item => item.id === subject.blueprintId && item.characterId === subject.characterId)
    return blueprint ? { title: blueprint.title, id: catalogShowcaseId({ kind: 'blueprint', characterId: subject.characterId, id: blueprint.id }), rating: blueprint.adult ? 'R18' : blueprint.sampleRating } : null
  }
  return pb.activeScene ? { title: pb.activeScene.title, id: pb.activeScene.id, rating: pb.activeScene.mature ? 'R18' : pb.activeScene.rating } : null
})
const { loading, entryFor, thumbUrl } = useShowcaseAssets()
const entry = computed(() => {
  const item = scene.value ? entryFor(scene.value.id) : undefined
  return item?.type === 'scene' || item?.type === 'popular' ? item : undefined
})
const restricted = computed(() => entry.value?.rating === 'R18' || scene.value?.rating === 'R18')
const imageUrl = computed(() => {
  return entry.value ? thumbUrl(entry.value.id) : ''
})
const canLoad = computed(() => !!imageUrl.value)
const { image: runtimeImage, src, failed } = useRuntimeImage(() => attached.value && canLoad.value ? imageUrl.value : '')
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
.scene-reference-empty { display:grid; justify-items:center; align-content:center; gap:20px; height:100%; line-height:var(--lh-loose); color:var(--text-primary); }
.scene-reference-empty .archive-icon { width:32px; height:32px; }
figcaption { flex:none; max-width:100%; }
figcaption strong { display:none; }
figcaption p { margin:8px 0 12px; color:var(--text-secondary); font-size:var(--fs-label); line-height:var(--lh-loose); }
.scene-reference-settings { display:flex; flex-wrap:wrap; justify-content:center; gap:12px 24px; margin:0; }
.scene-reference-settings dt { color:var(--text-secondary); }
.scene-reference-settings dd { color:var(--text-primary); margin:4px 0 0; }
@container canvas-column (max-width:440px) { .scene-reference-settings { gap:8px; } }
</style>
