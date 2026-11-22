<template>
  <figure v-if="scene" class="scene-reference" aria-label="当前场景参考">
    <div class="scene-reference-picture tw:relative tw:overflow-hidden tw:grid tw:rounded-lg" :class="{ 'is-restricted': restricted }"
      @pointerenter="tilt.enter" @pointermove="tilt.move" @pointerleave="tilt.reset" @pointercancel="tilt.reset">
      <img v-if="image.src && !failed" ref="art" v-bind="image" :alt="restricted ? '' : `${scene.title}的场景参考样张`" decoding="async" />
      <div v-else class="scene-reference-empty tw:grid tw:gap-s-3 tw:p-s-4 tw:text-body tw:text-center"><ArchiveIcon name="image" /><span>{{ loading ? '核对样张中…' : !entry || failed ? '暂无参考样张' : '已遮挡' }}</span></div>
      <span v-if="restricted && imageUrl && !failed" class="scene-reference-mask tw:absolute tw:grid tw:text-primary tw:text-label">分级参考 · 已模糊</span>
    </div>
    <figcaption>
      <span class="scene-reference-label">SCENE REFERENCE · 场景参考</span>
      <strong class="scene-reference-title">{{ scene.title }}</strong>
      <p class="scene-reference-quote">{{ scene.story || '观察场景氛围，出图以当前设置为准。' }}</p>
      <dl class="scene-reference-settings scene-reference-filmbar" aria-label="当前镜头与画幅参数">
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
    return blueprint
      ? {
          title: blueprint.title,
          story: blueprint.description || pb.story || '',
          id: catalogShowcaseId({ kind: 'blueprint', characterId: subject.characterId, id: blueprint.id }),
        }
      : null
  }
  return pb.activeScene
    ? {
        title: pb.activeScene.title,
        story: pb.activeScene.story || pb.story || '',
        id: pb.activeScene.id,
      }
    : null
})
const { loading, entryFor, thumbUrl, imageUrl: originalUrl } = useShowcaseAssets(undefined, () => attached.value && !!scene.value)
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
figcaption { flex:none; max-width:min(540px, 100%); display:grid; gap:6px; justify-items:center; }
.scene-reference-label { display:inline-flex; align-items:center; gap:var(--s-1); color:var(--character-ink, var(--accent)); font:600 var(--fs-mono-xs)/var(--lh-label) var(--font-mono); letter-spacing:.08em; }
.scene-reference-title { display:block; color:var(--text-primary); font:600 var(--fs-title-sm)/var(--lh-tight) var(--font-serif); overflow-wrap:anywhere; }
.scene-reference-quote { display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; margin:0; max-width:44ch; color:var(--text-secondary); font:400 var(--fs-body-sm)/var(--lh-body) var(--font-serif); }
.scene-reference-filmbar { display:inline-flex; flex-wrap:wrap; align-items:center; justify-content:center; gap:6px 14px; margin:4px 0 0; padding:4px 12px; border:1px solid var(--border-soft); border-radius:var(--r-pill); background:var(--bg-base); font:400 var(--fs-label-xs)/var(--lh-label) var(--font-sans); }
.scene-reference-filmbar > div { display:inline-flex; align-items:baseline; gap:4px; }
.scene-reference-filmbar dt { color:var(--text-muted); }
.scene-reference-filmbar dd { margin:0; color:var(--text-primary); font-weight:500; }
@container canvas-column (max-width:440px) { .scene-reference-filmbar { gap:4px 10px; border-radius:var(--r-md); } }
</style>
