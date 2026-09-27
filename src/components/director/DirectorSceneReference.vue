<template>
  <figure v-if="scene" class="scene-reference" :class="{ 'is-unconnected': !loading && !entry }" aria-label="当前场景参考">
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
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'
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
// Unknown ratings remain closed; the reference never changes the generation subject or draft.
const entry = computed(() => entries.value.find(item => item.id === scene.value?.id && (item.type === 'scene' || item.type === 'popular')))
const restricted = computed(() => entry.value?.rating !== 'All' || ['R15', 'R18'].includes(scene.value?.rating ?? ''))
const imageUrl = computed(() => {
  if (!entry.value) return ''
  const path = entry.value.thumb || `thumbs/${entry.value.id}.jpg`
  return /^(?:thumbs|images)\/[a-zA-Z0-9_-]+\.(?:jpg|jpeg|png|webp)$/.test(path) ? `/scene-showcase/${path}` : ''
})
const canLoad = computed(() => !!imageUrl.value && (!restricted.value || isLocalStudioHost()))
const { image, failed } = useRuntimeImage(() => canLoad.value ? imageUrl.value : '')
const shot = computed(() => SHOT.find(item => item.id === pb.selections.shot)?.name ?? '跟随场景')
const composition = computed(() => COMPOSITION.find(item => item.id === pb.selections.composition)?.name ?? '跟随场景')
const lighting = computed(() => LIGHTING.find(item => item.id === pb.selections.lighting)?.name ?? '跟随场景')
</script>

<style scoped>
@reference "../../assets/css/tailwind.css";
.scene-reference { @apply tw:grid; grid-template-columns:minmax(120px,.9fr) minmax(0,1fr); @apply tw:gap-s-4; margin:0 0 var(--s-4); @apply tw:text-left tw:items-center; }
.scene-reference-picture { place-items:center; aspect-ratio:4/3; background:var(--bg-base); }
.scene-reference-picture img { @apply tw:absolute; inset:0; @apply tw:block tw:w-full tw:h-full tw:object-contain; }
.scene-reference.is-unconnected .scene-reference-picture { aspect-ratio:auto; @apply tw:min-h-[104px]; }
.scene-reference-picture.is-restricted img { filter:blur(24px); transform:scale(1.15); }
.scene-reference-mask { inset:0; place-items:center; background:color-mix(in srgb,var(--bg-surface) 85%,transparent); }
.scene-reference-empty { justify-items:center; }
.scene-reference-empty .archive-icon { @apply tw:w-[32px] tw:h-[32px]; }
figcaption strong { @apply tw:text-primary tw:text-body tw:leading-label; }
figcaption p { margin:var(--s-2) 0 var(--s-3); @apply tw:text-secondary tw:text-label tw:leading-loose; }
.scene-reference-settings { gap:var(--s-2) var(--s-4); }
.scene-reference-settings dt { @apply tw:text-secondary; }
.scene-reference-settings dd { margin:var(--s-1) 0 0; @apply tw:text-primary; }
@container canvas-column (max-width:440px) { .scene-reference { grid-template-columns:1fr; } .scene-reference-picture { @apply tw:max-h-[190px]; aspect-ratio:16/9; } }
@media (min-width:901px) and (max-height:760px) { .scene-reference-picture { @apply tw:max-h-[180px]; } }
</style>
