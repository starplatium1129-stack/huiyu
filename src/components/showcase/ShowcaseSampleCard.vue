<template>
  <article class="sample" :class="{ 'sample-r18': entry.rating === 'R18' }" :data-rating="entry.rating" :data-sample-id="entry.id">
    <button class="sample-visual tw:block tw:w-full tw:p-0 tw:text-left tw:relative tw:overflow-hidden" :class="{ 'sample-visual-measured': entry.width && entry.height }" type="button"
      :style="imageStyle"
      :aria-label="'查看 ' + entry.title + ' 大图'" @click="emit('open', entry.id)">
      <img v-if="image.src && !broken" v-bind="image" class="sample-image tw:w-full tw:h-auto tw:block" :class="{ 'sample-image-ready': loaded }"
        :alt="entry.title" :width="entry.width" :height="entry.height" loading="lazy" decoding="async" />
      <span v-else class="sample-image-fallback tw:grid tw:min-h-[260px] tw:text-glyph" aria-hidden="true"><ArchiveIcon name="image" /></span>
      <span v-if="entry.rating === 'R18'" class="sample-sensitive tw:absolute tw:grid tw:gap-[2px] tw:min-w-[112px] tw:rounded-pill tw:pointer-events-none"><strong>R18</strong><span>悬停或聚焦预览</span></span>
    </button>
    <div class="sample-caption">
      <div class="sample-kicker tw:flex tw:justify-between tw:items-center tw:gap-s-2 tw:text-secondary tw:text-label-xs tw:leading-body"><span>{{ characterLabel }}</span><span class="sample-rating tw:shrink-0 tw:text-muted">{{ ratingLabel }}</span></div>
      <h3 class="sample-title tw:text-primary tw:text-body tw:font-semibold tw:leading-body">{{ entry.title }}</h3>
      <div class="sample-badges tw:flex tw:justify-between tw:items-center tw:gap-s-2 tw:min-h-[24px] tw:text-muted tw:text-label-xs">
        <span v-if="featured" class="sample-badge"><ArchiveIcon name="star" /> 精选</span>
        <span v-else-if="entry.type !== 'scene'" class="sample-badge sample-badge-type">{{ typeLabel }}</span>
        <span v-else class="sample-category tw:overflow-hidden tw:whitespace-nowrap tw:text-ellipsis">{{ entry.category || '场景样张' }}</span>
        <span class="sample-open-hint tw:inline-flex tw:items-center tw:gap-s-1 tw:shrink-0" aria-hidden="true"><ArchiveIcon name="eye" /> 查看大图</span>
      </div>
    </div>
  </article>
</template>

<script setup lang="ts">
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { useRuntimeImage } from '@/composables/useRuntimeImage'
import type { ShowcaseEntry } from '@/utils/showcaseManifest'
import { computed } from 'vue'

const props = defineProps<{ entry: ShowcaseEntry; src: string; featured: boolean; characterLabel: string; typeLabel: string; ratingLabel: string }>()
const imageStyle = computed(() => ({ '--sample-ratio': props.entry.width && props.entry.height ? `${props.entry.width} / ${props.entry.height}` : '3 / 4' }))
const { image, loaded, failed: broken } = useRuntimeImage(() => props.src)
const emit = defineEmits<{ open: [id: string] }>()
</script>

<style scoped>
@reference "../../assets/css/tailwind.css";
.sample { @apply tw:overflow-hidden tw:relative; border:1px solid var(--border-soft); @apply tw:rounded-lg; background:var(--bg-surface); transition:transform var(--motion-hover); }
.sample-visual { border:0; background:var(--art-mat); color:var(--on-art-primary); cursor:zoom-in; }
/* 已知尺寸预留比例框；未知尺寸使用图片自然高度，始终完整展示原画。 */
.sample-visual-measured { aspect-ratio:var(--sample-ratio, 3 / 4); }
.sample-visual:focus-visible { outline:3px solid var(--accent); outline-offset:-3px; }
.sample-image { background:var(--art-mat); opacity:0; transition:opacity var(--motion-route) var(--ease-out),transform var(--motion-route) var(--ease-out); }
.sample-visual-measured .sample-image { @apply tw:h-full tw:object-contain; }
.sample-image-ready { opacity:1; }
.sample-image-fallback { place-items:center; color:var(--on-art-secondary); }
.sample-visual-measured .sample-image-fallback { @apply tw:h-full tw:min-h-0; }
/* 模糊仅在原有预览触发时切换，不给 filter 添加逐帧过渡。 */
.sample-r18 .sample-image { filter:blur(18px) saturate(.78); transform:scale(1.08); }
.sample-sensitive { z-index:var(--z-raised); inset:50% auto auto 50%; justify-items:center; padding:var(--s-3) var(--s-4); transform:translate(-50%,-50%); border:1px solid var(--on-art-line); background:var(--art-scrim); color:var(--on-art-primary); transition:opacity var(--motion-surface),transform var(--motion-surface); }
.sample-sensitive strong { @apply tw:text-label-sm; letter-spacing:.12em; }
.sample-sensitive span { color:var(--on-art-secondary); @apply tw:text-mono-xs; }
.sample-caption { padding:var(--s-3) var(--s-4) var(--s-4); }
.sample-kicker > span:first-child { @apply tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap; }
.sample-title { margin:var(--s-2) 0 var(--s-3); overflow-wrap:anywhere; }
.sample-badge { @apply tw:inline-flex tw:items-center tw:gap-s-1; padding:var(--s-1) var(--s-2); border:1px solid var(--border-soft); @apply tw:rounded-pill tw:text-accent; background:var(--accent-soft); @apply tw:text-label-xs; }
.sample-badge-type { @apply tw:text-secondary; background:var(--bg-base); }
@media (hover: hover) and (pointer: fine) {
  .sample:hover { @apply tw:border-accent; }
  .sample-r18:hover .sample-image { filter:blur(0) saturate(1); transform:scale(1.018); }
  .sample-r18:hover .sample-sensitive { opacity:0; transform:translate(-50%,-45%); }
}
.sample-r18:focus-within .sample-image { filter:blur(0) saturate(1); transform:scale(1.08); }
.sample-r18:focus-within .sample-sensitive { opacity:0; }
@media (hover: hover) and (prefers-reduced-motion: no-preference) {
  html:not([data-reduced-motion="true"]) .sample:hover { transform:translateY(-3px); }
  html:not([data-reduced-motion="true"]) .sample:not(.sample-r18):hover .sample-image { transform:scale(1.018); }
}
@media (max-width: 480px) { .sample-caption { @apply tw:p-s-3; } .sample-open-hint { @apply tw:hidden; } .sample-title { @apply tw:text-body-sm; } }
@media (prefers-reduced-motion:reduce) { .sample,.sample-image,.sample-sensitive { transition:none; } }
</style>
