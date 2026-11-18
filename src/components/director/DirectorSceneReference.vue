<template>
  <figure v-if="scene" class="scene-reference" aria-label="当前场景参考">
    <div class="scene-reference-picture tw:relative tw:overflow-hidden tw:grid tw:rounded-lg" :class="{ 'is-restricted': restricted }"
      @pointerenter="tilt.enter" @pointermove="tilt.move" @pointerleave="tilt.reset" @pointercancel="tilt.reset">
      <img v-if="image.src && !failed" ref="art" v-bind="image" :alt="restricted ? '' : `${scene.title}的场景参考样张`" decoding="async" />
      <div v-else class="scene-reference-empty tw:grid tw:gap-s-3 tw:p-s-4 tw:text-body tw:text-center"><ArchiveIcon name="image" /><span>{{ loading ? '核对样张中…' : !entry || failed ? '暂无参考样张' : '已遮挡' }}</span></div>
      <span v-if="restricted && imageUrl && !failed" class="scene-reference-mask tw:absolute tw:grid tw:text-primary tw:text-label">分级参考 · 已模糊</span>
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
import { useArtworkTilt } from '@/composables/useArtworkTilt'
import { computed, onActivated, onDeactivated, ref } from 'vue'
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
    return blueprint ? { title: blueprint.title, id: catalogShowcaseId({ kind: 'blueprint', characterId: subject.characterId, id: blueprint.id }) } : null
  }
  return pb.activeScene ? { title: pb.activeScene.title, id: pb.activeScene.id } : null
})
const { loading, entryFor, thumbUrl, imageUrl: originalUrl } = useShowcaseAssets()
const entry = computed(() => {
  const item = scene.value ? entryFor(scene.value.id) : undefined
  return item?.type === 'scene' || item?.type === 'popular' ? item : undefined
})
const restricted = computed(() => entry.value?.rating === 'R18')
const imageUrl = computed(() => {
  if (!entry.value) return ''
  return restricted.value ? thumbUrl(entry.value.id) : originalUrl(entry.value.id)
})
const { image, failed } = useRuntimeImage(() => attached.value ? imageUrl.value : '')
const art = ref<HTMLImageElement | null>(null)
const tilt = useArtworkTilt(art, () => !restricted.value && !!image.value.src && !failed.value)
const shot = computed(() => SHOT.find(item => item.id === pb.selections.shot)?.name ?? '跟随场景')
const composition = computed(() => COMPOSITION.find(item => item.id === pb.selections.composition)?.name ?? '跟随场景')
const lighting = computed(() => LIGHTING.find(item => item.id === pb.selections.lighting)?.name ?? '跟随场景')
</script>

<style scoped>
.scene-reference { display:flex; flex-direction:column; align-items:center; gap:20px; margin:0; min-height:0; width:100%; text-align:center; }
.scene-reference-picture { position:relative; width:100%; flex:1; min-height:0; overflow:hidden; display:grid; place-items:center; background:transparent; }
.scene-reference-picture img { position:absolute; inset:0; width:100%; height:100%; object-fit:contain; }
.scene-reference-picture:not(.is-restricted) img { transition:transform var(--motion-control) var(--ease-out); }
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
