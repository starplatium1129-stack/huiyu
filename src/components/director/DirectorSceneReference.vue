<template>
  <figure class="scene-reference" :class="{ 'is-text-entry': !hasImage }" :style="{ '--reference-image-ratio': referenceVisible ? imageRatio ? String(imageRatio) : undefined : '0.68421' }" aria-label="创作起点">
    <div v-if="hasImage" class="scene-reference-picture tw:relative tw:overflow-hidden tw:grid tw:rounded-lg" :class="{ 'is-restricted': referenceVisible && restricted }">
      <img v-if="referenceVisible" class="scene-reference-sample" v-bind="image" :alt="restricted ? '' : `${scene?.title}的场景参考样张，非本次生成`" decoding="async" />
      <img v-else-if="!studioImage.failed.value" class="scene-reference-studio" v-bind="studioImage.image.value" alt="画室角色素材，非本次生成" decoding="async" />
      <span v-if="referenceVisible && restricted" class="scene-reference-mask tw:absolute tw:grid tw:text-primary tw:text-label">分级参考 · 已模糊</span>
    </div>
    <figcaption>
      <span class="scene-reference-label tw:block tw:mb-s-2 tw:text-secondary tw:text-label">{{ referenceVisible ? '场景参考 · 非本次生成' : '画室素材 · 非本次生成' }}</span>
      <strong>{{ scene?.title || '从这一幕开始' }}</strong>
      <p v-if="entry && restricted && !canLoad" class="scene-reference-risk">分级参考已遮挡</p>
      <slot />
      <slot name="actions" :has-scene="Boolean(scene)" />
    </figcaption>
  </figure>
</template>

<script setup lang="ts">
import { useRuntimeImage } from '@/composables/useRuntimeImage'

import { runtimeFetch, runtimeResourceIdentity } from '@/platform/runtimeUrl'

import { computed, ref, watch } from 'vue'
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'
import { parseShowcaseManifest, type ShowcaseEntry } from '@/utils/showcaseManifest'

defineProps<{ size?: string }>()
const pb = usePromptBuilderStore()
const entries = ref<ShowcaseEntry[]>([])
watch(runtimeResourceIdentity, async (_identity, _previous, cleanup) => {
  const controller = new AbortController()
  cleanup(() => controller.abort())
  entries.value = []
  try {
    const response = await runtimeFetch('/scene-showcase/manifest.json', { signal: controller.signal, cache: 'no-cache' })
    if (!response.ok) return
    const raw = await response.json() as { entries?: Array<{ id?: unknown } | null> }
    if (!Array.isArray(raw.entries)) return
    const counts = new Map<unknown, number>()
    for (const item of raw.entries) counts.set(item?.id, (counts.get(item?.id) ?? 0) + 1)
    if (!controller.signal.aborted) entries.value = parseShowcaseManifest(raw).entries.filter(item => counts.get(item.id) === 1)
  } catch { /* Unverified references stay closed; drafting remains available. */ }
}, { immediate: true })
const scene = computed(() => {
  const subject = pb.subject
  if (subject.kind === 'popular') {
    const blueprint = pb.sceneBlueprints.find(item => item.id === subject.blueprintId && item.characterId === subject.characterId)
    return blueprint ? { title: blueprint.title, id: `pc_${subject.characterId}_${blueprint.id}`, rating: blueprint.adult ? 'R18' : blueprint.sampleRating } : null
  }
  return pb.activeScene ? { title: pb.activeScene.title, id: pb.activeScene.id, rating: pb.activeScene.mature ? 'R18' : pb.activeScene.rating } : null
})
// Unknown ratings remain closed; the reference never changes the generation subject or draft.
const entry = computed(() => entries.value.find(item => item.id === scene.value?.id && (item.type === 'scene' || item.type === 'popular')))
const restricted = computed(() => entry.value?.rating !== 'All' || ['R15', 'R18'].includes(scene.value?.rating ?? ''))
const imageUrl = computed(() => {
  if (!entry.value) return ''
  const path = entry.value.thumb || `thumbs/${entry.value.id}.jpg`
  return /^(?:thumbs|images)\/[a-zA-Z0-9_-]+\.(?:jpg|jpeg|png|webp)$/.test(path) ? `/scene-showcase/${path}` : ''
})
const canLoad = computed(() => !!imageUrl.value && (!restricted.value || isLocalStudioHost()))
const { image: runtimeImage, src, failed } = useRuntimeImage(() => canLoad.value ? imageUrl.value : '')
const referenceVisible = computed(() => !!src.value && !failed.value)
// Fixed shipped character art is a studio entry, never an unverified scene sample.
const studioImage = useRuntimeImage(() => `/assets/characters/${pb.subject.kind !== 'popular' && pb.char === 'nene' ? 'nene' : 'natsume'}-home-cg.jpg`)
const hasImage = computed(() => referenceVisible.value || !!studioImage.src.value && !studioImage.failed.value)
const imageRatio = ref<number | null>(null)
watch([src, runtimeResourceIdentity], () => { imageRatio.value = null }, { flush: 'sync' })
function measureImage(event: Event) {
  if (!runtimeImage.value.onLoad(event)) return
  const image = event.target as HTMLImageElement
  imageRatio.value = image.naturalWidth / image.naturalHeight
}
const image = computed(() => ({ ...runtimeImage.value, onLoad: measureImage }))
</script>

<style scoped>
@reference "../../assets/css/tailwind.css";
.scene-reference { --reference-max-height:clamp(240px,calc(var(--drawing-viewport-height,100vh) - 270px),760px); display:grid; grid-template-columns:minmax(0,min(62%,calc(var(--reference-max-height) * var(--reference-image-ratio,.68421)))) minmax(180px,1fr); gap:var(--s-5); margin:0; text-align:left; align-items:center; }
.scene-reference.is-text-entry { grid-template-columns:minmax(0,1fr); }
.scene-reference-picture { width:min(100%,calc(var(--reference-max-height) * var(--reference-image-ratio,1.333333))); max-height:var(--reference-max-height); justify-self:center; place-items:center; aspect-ratio:var(--reference-image-ratio,4/3); background:var(--bg-base); }
.scene-reference-picture img { @apply tw:absolute; inset:0; @apply tw:block tw:w-full tw:h-full tw:object-contain; }
.scene-reference-picture.is-restricted img { filter:blur(24px); transform:scale(1.15); }
.scene-reference-mask { inset:0; place-items:center; background:color-mix(in srgb,var(--bg-surface) 85%,transparent); }
.scene-reference-empty { justify-items:center; }
.scene-reference-empty .archive-icon { @apply tw:w-[32px] tw:h-[32px]; }
figcaption strong { color:var(--text-primary); font:600 var(--fs-title)/var(--lh-tight) var(--font-sans); }
figcaption p { margin:var(--s-2) 0 var(--s-3); @apply tw:text-secondary tw:text-label tw:leading-loose; }
.scene-reference:has(.stage-generating-copy) { margin-bottom:0; }
@container canvas-column (max-width:640px) { .scene-reference { --reference-max-height:300px; grid-template-columns:minmax(0,1fr); gap:var(--s-3); } figcaption { text-align:center; } }
@media (min-width:901px) and (max-height:760px) { .scene-reference { --reference-max-height:200px; } }
</style>
