<template>
  <article class="sample" :class="{ 'sample-r18': entry.rating === 'R18' }" :style="cardStyle" :data-rating="entry.rating" :data-sample-id="entry.id">
    <button class="sample-visual tw:block tw:w-full tw:p-0 tw:text-left tw:relative tw:overflow-hidden" type="button"
      :style="imageStyle"
      :aria-label="'查看 ' + entry.title + ' 大图'" @click="emit('open', entry.id)">
      <img v-if="image.src && !broken" v-bind="{ ...image, onLoad: measureImage }" class="sample-image tw:w-full tw:h-auto tw:block" :class="{ 'sample-image-ready': loaded }"
        :alt="entry.title" :width="entry.width" :height="entry.height" loading="lazy" decoding="async" />
      <span v-else class="sample-image-fallback tw:grid tw:min-h-[260px] tw:text-glyph" aria-hidden="true"><ArchiveIcon name="image" /></span>
      <span v-if="entry.rating === 'R18'" class="sample-sensitive tw:absolute tw:grid tw:gap-[2px] tw:min-w-[112px] tw:rounded-pill tw:pointer-events-none"><strong>R18</strong><span>悬停或聚焦预览</span></span>
    </button>
    <div class="sample-caption">
      <div class="sample-kicker tw:flex tw:justify-between tw:items-center tw:gap-s-2 tw:text-secondary tw:text-label-xs tw:leading-body"><span>{{ characterLabel }}</span><span v-if="featured" class="sample-featured" title="精选"><ArchiveIcon name="star" /><span class="sr-only">精选</span></span><span class="sample-rating tw:shrink-0 tw:text-muted">{{ ratingLabel }}</span></div>
      <h3 class="sample-title tw:text-primary tw:text-body tw:font-semibold tw:leading-body">{{ displayTitle }}</h3>
    </div>
  </article>
</template>

<script setup lang="ts">
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { useRuntimeImage } from '@/composables/useRuntimeImage'
import type { ShowcaseEntry } from '@/utils/showcaseManifest'
import { computed, ref, watch } from 'vue'

const props = defineProps<{ entry: ShowcaseEntry; src: string; featured: boolean; characterLabel: string; ratingLabel: string }>()
const displayTitle = computed(() => {
  const name = props.characterLabel.trim(), original = props.entry.title.trim()
  let title = original
  while (name && title.startsWith(name)) {
    const suffix = title.slice(name.length)
    if (!/^[\s·•｜|/：:—-]/u.test(suffix)) break
    const next = suffix.replace(/^[\s·•｜|/：:—-]+/u, '').trim()
    if (!next) break
    title = next
  }
  return title
})
const { image, loaded, failed: broken } = useRuntimeImage(() => props.src)
const naturalSize = ref<{ width: number; height: number } | null>(null)
watch([() => props.src, () => props.entry.id], () => { naturalSize.value = null })
const dimensions = computed(() => naturalSize.value || (props.entry.width && props.entry.height ? { width: props.entry.width, height: props.entry.height } : { width: 3, height: 4 }))
const imageStyle = computed(() => ({ '--sample-ratio': `${dimensions.value.width} / ${dimensions.value.height}` }))
const cardStyle = computed(() => ({ '--sample-grow': dimensions.value.width / dimensions.value.height }))
function measureImage(event: Event) {
  // useRuntimeImage validates the source and retry identity before accepting a load.
  if (!image.value.onLoad(event)) return
  const img = event.target as HTMLImageElement
  naturalSize.value = { width: img.naturalWidth, height: img.naturalHeight }
}
const emit = defineEmits<{ open: [id: string] }>()
</script>

<style scoped>
@reference "../../assets/css/tailwind.css";
.sample { @apply tw:overflow-hidden tw:relative tw:min-w-0; flex:var(--sample-grow) 1 calc(var(--showcase-row-height,320px) * var(--sample-grow)); max-width:100%; border:1px solid var(--border-soft); border-radius:var(--r-sm); background:var(--bg-surface); }
:root body .showcase-page .sample { border-radius:var(--r-sm); box-shadow:none; transition:none; }
:root body .showcase-page .sample:hover { transform:none; }
/* 自然尺寸校正缺失或过时的目录尺寸；按原始比例分配行宽，完整展示原画。 */
.sample-visual { aspect-ratio:var(--sample-ratio, 3 / 4); border:0; background:var(--art-mat); color:var(--on-art-primary); cursor:zoom-in; }
.sample-visual:focus-visible { outline:3px solid var(--accent); outline-offset:-3px; }
.sample-image { @apply tw:h-full tw:object-contain; background:var(--art-mat); opacity:0; transition:opacity var(--motion-hover) var(--ease-out); }
.sample-image-ready { opacity:1; }
.sample-image-fallback { @apply tw:h-full tw:min-h-0; place-items:center; color:var(--on-art-secondary); }
/* 模糊仅在原有预览触发时切换，不给 filter 添加逐帧过渡。 */
.sample-r18 .sample-image { filter:blur(18px) saturate(.78); transform:scale(1.08); }
.sample-sensitive { z-index:var(--z-raised); inset:50% auto auto 50%; justify-items:center; padding:var(--s-3) var(--s-4); transform:translate(-50%,-50%); border:1px solid var(--on-art-line); background:var(--art-scrim); color:var(--on-art-primary); transition:opacity var(--motion-hover) var(--ease-out); }
.sample-sensitive strong { @apply tw:text-label-sm; letter-spacing:.12em; }
.sample-sensitive span { color:var(--on-art-secondary); @apply tw:text-mono-xs; }
.sample-caption { position:relative; display:grid; grid-template-columns:minmax(0,1fr) auto; gap:var(--s-1) var(--s-2); padding:var(--s-3); border-top:1px solid var(--border-soft); }
.sample-kicker { grid-column:1 / -1; }
.sample-kicker > span:first-child { @apply tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap; }
.sample-title { grid-column:1 / -1; margin:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:var(--fs-body-sm); }
.sample-featured { display:inline-flex; margin-left:auto; color:var(--accent); }
.sample-featured .archive-icon { width:14px; height:14px; }
.sample-badges { justify-content:end; }
.sample-category,.sample-open-hint { display:none; }
.sample-badge { @apply tw:inline-flex tw:items-center tw:gap-s-1; padding:var(--s-1) var(--s-2); border:0; @apply tw:rounded-pill tw:text-accent; background:var(--accent-soft); @apply tw:text-label-xs; }
.sample-badge-type { @apply tw:text-secondary; background:var(--bg-base); }
@media (hover: hover) and (pointer: fine) {
  .sample:hover { @apply tw:border-accent; }
  .sample-r18:hover .sample-image { filter:blur(0) saturate(1); }
  .sample-r18:hover .sample-sensitive { opacity:0; }
}
.sample-r18:focus-within .sample-image { filter:blur(0) saturate(1); transform:scale(1.08); }
.sample-r18:focus-within .sample-sensitive { opacity:0; transition:none; }
@media (max-width: 480px) { .sample-caption { @apply tw:p-s-3; } .sample-open-hint { @apply tw:hidden; } .sample-title { @apply tw:text-body-sm; } }
@media (prefers-reduced-motion:reduce) { .sample-image,.sample-sensitive { transition:opacity var(--motion-press) var(--ease-out); } }
:root:is([data-motion='reduce'],[data-motion='reduced']) .sample-image,
:root:is([data-motion='reduce'],[data-motion='reduced']) .sample-sensitive { transition:opacity var(--motion-press) var(--ease-out); }
</style>
