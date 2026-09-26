<template>
  <article class="sample" :class="{ 'sample-r18': entry.rating === 'R18' }" :data-rating="entry.rating">
    <button class="sample-visual" :class="{ 'sample-visual-measured': entry.width && entry.height }" type="button"
      :style="{ '--sample-ratio': entry.width && entry.height ? `${entry.width} / ${entry.height}` : '3 / 4' }"
      :aria-label="'查看 ' + entry.title + ' 大图'" @click="emit('open', entry.id)">
      <img v-if="!broken" :crossorigin="runtimeResourceCors()" class="sample-image" :class="{ 'sample-image-ready': loaded }"
        :src="resolveRuntimeUrl(src)" :alt="entry.title" :width="entry.width" :height="entry.height" loading="lazy" decoding="async" @load="emit('loaded', entry)" @error="emit('error', entry)" />
      <span v-else class="sample-image-fallback" aria-hidden="true"><ArchiveIcon name="image" /></span>
      <span v-if="entry.rating === 'R18'" class="sample-sensitive"><strong>R18</strong><span>悬停或聚焦预览</span></span>
    </button>
    <div class="sample-caption">
      <div class="sample-kicker"><span>{{ characterLabel }}</span><span class="sample-rating">{{ ratingLabel }}</span></div>
      <h3 class="sample-title">{{ entry.title }}</h3>
      <div class="sample-badges">
        <span v-if="featured" class="sample-badge"><ArchiveIcon name="star" /> 精选</span>
        <span v-else-if="entry.type !== 'scene'" class="sample-badge sample-badge-type">{{ typeLabel }}</span>
        <span v-else class="sample-category">{{ entry.category || '场景样张' }}</span>
        <span class="sample-open-hint" aria-hidden="true"><ArchiveIcon name="eye" /> 查看大图</span>
      </div>
    </div>
  </article>
</template>

<script setup lang="ts">
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { resolveRuntimeUrl, runtimeResourceCors } from '@/platform/runtimeUrl'
import type { ShowcaseEntry } from '@/utils/showcaseManifest'

defineProps<{ entry: ShowcaseEntry; src: string; loaded: boolean; broken: boolean; featured: boolean; characterLabel: string; typeLabel: string; ratingLabel: string }>()
const emit = defineEmits<{ open: [id: string]; loaded: [entry: ShowcaseEntry]; error: [entry: ShowcaseEntry] }>()
</script>

<style scoped>
.sample { overflow:hidden; position:relative; border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--bg-surface); transition:transform var(--motion-hover); }
.sample-visual { display:block; width:100%; padding:0; border:0; background:var(--art-mat); color:var(--on-art-primary); text-align:left; cursor:zoom-in; position:relative; overflow:hidden; }
/* 已知尺寸预留比例框；未知尺寸使用图片自然高度，始终完整展示原画。 */
.sample-visual-measured { aspect-ratio:var(--sample-ratio, 3 / 4); }
.sample-visual:focus-visible { outline:3px solid var(--accent); outline-offset:-3px; }
.sample-image { width:100%; height:auto; display:block; background:var(--art-mat); opacity:0; transition:opacity var(--motion-route) var(--ease-out),transform var(--motion-route) var(--ease-out); }
.sample-visual-measured .sample-image { height:100%; object-fit:contain; }
.sample-image-ready { opacity:1; }
.sample-image-fallback { display:grid; min-height:260px; place-items:center; color:var(--on-art-secondary); font-size:var(--fs-glyph); }
.sample-visual-measured .sample-image-fallback { height:100%; min-height:0; }
/* 模糊仅在原有预览触发时切换，不给 filter 添加逐帧过渡。 */
.sample-r18 .sample-image { filter:blur(18px) saturate(.78); transform:scale(1.08); }
.sample-sensitive { position:absolute; z-index:var(--z-raised); inset:50% auto auto 50%; display:grid; justify-items:center; gap:2px; min-width:112px; padding:var(--s-3) var(--s-4); transform:translate(-50%,-50%); border:1px solid var(--on-art-line); border-radius:var(--r-pill); background:var(--art-scrim); color:var(--on-art-primary); pointer-events:none; transition:opacity var(--motion-surface),transform var(--motion-surface); }
.sample-sensitive strong { font-size:var(--fs-label-sm); letter-spacing:.12em; }
.sample-sensitive span { color:var(--on-art-secondary); font-size:var(--fs-mono-xs); }
.sample-caption { padding:var(--s-3) var(--s-4) var(--s-4); }
.sample-kicker { display:flex; justify-content:space-between; align-items:center; gap:var(--s-2); color:var(--text-secondary); font-size:var(--fs-label-xs); line-height:var(--lh-body); }
.sample-kicker > span:first-child { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sample-rating { flex-shrink:0; color:var(--text-muted); }
.sample-title { margin:var(--s-2) 0 var(--s-3); color:var(--text-primary); font-size:var(--fs-body); font-weight:600; line-height:var(--lh-body); overflow-wrap:anywhere; }
.sample-badges { display:flex; justify-content:space-between; align-items:center; gap:var(--s-2); min-height:24px; color:var(--text-muted); font-size:var(--fs-label-xs); }
.sample-badge { display:inline-flex; align-items:center; gap:var(--s-1); padding:var(--s-1) var(--s-2); border:1px solid var(--border-soft); border-radius:var(--r-pill); color:var(--accent); background:var(--accent-soft); font-size:var(--fs-label-xs); }
.sample-badge-type { color:var(--text-secondary); background:var(--bg-base); }
.sample-category { overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.sample-open-hint { display:inline-flex; align-items:center; gap:var(--s-1); flex-shrink:0; }
@media (hover: hover) and (pointer: fine) {
  .sample:hover { border-color:var(--accent); }
  .sample-r18:hover .sample-image { filter:blur(0) saturate(1); transform:scale(1.018); }
  .sample-r18:hover .sample-sensitive { opacity:0; transform:translate(-50%,-45%); }
}
.sample-r18:focus-within .sample-image { filter:blur(0) saturate(1); transform:scale(1.08); }
.sample-r18:focus-within .sample-sensitive { opacity:0; }
@media (hover: hover) and (prefers-reduced-motion: no-preference) {
  html:not([data-reduced-motion="true"]) .sample:hover { transform:translateY(-3px); }
  html:not([data-reduced-motion="true"]) .sample:not(.sample-r18):hover .sample-image { transform:scale(1.018); }
}
@media (max-width: 480px) { .sample-caption { padding:var(--s-3); } .sample-open-hint { display:none; } .sample-title { font-size:var(--fs-body-sm); } }
@media (prefers-reduced-motion:reduce) { .sample,.sample-image,.sample-sensitive { transition:none; } }
</style>
