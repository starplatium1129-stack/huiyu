<template>
  <section v-if="albums.length" class="showcase-albums" aria-labelledby="showcaseAlbumsTitle">
    <div class="albums-heading">
      <div><span class="albums-kicker">THE COLLECTIONS</span><h2 id="showcaseAlbumsTitle">按册翻阅</h2></div>
      <button class="albums-all" type="button" :aria-pressed="selected === 'all'" @click="emit('select', 'all')">全部画册 <ArchiveIcon name="chevron-down" /></button>
    </div>
    <div class="albums-track">
      <button v-for="album in albums" :key="album.type" class="album-card" type="button"
        :aria-pressed="selected === album.type" :aria-label="`${album.title}，${album.count} 幅样张`" @click="emit('select', selected === album.type ? 'all' : album.type)">
        <span class="album-art">
          <span class="album-cover">
            <img v-if="album.cover && !brokenThumbs.has(album.cover.id)" :src="resolveRuntimeUrl(thumbSrc(album.cover))" :crossorigin="runtimeResourceCors()"
              alt="" loading="lazy" decoding="async" @error="emit('image-error', album.cover)" />
            <span v-else class="album-placeholder"><ArchiveIcon name="gallery" /><span>翻开这本画册</span></span>
          </span>
          <span v-if="selected === album.type" class="album-selected"><ArchiveIcon name="success" /></span>
        </span>
        <span class="album-copy"><strong>{{ album.title }}</strong><span>{{ album.count }} 幅</span></span>
        <span class="album-description">{{ album.description }}</span>
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import type { ShowcaseAlbum } from '@/composables/showcase/useShowcaseAlbums'
import { resolveRuntimeUrl, runtimeResourceCors } from '@/platform/runtimeUrl'
import type { ShowcaseEntry, ShowcaseEntryType } from '@/utils/showcaseManifest'

defineProps<{
  albums: ShowcaseAlbum[]
  selected: ShowcaseEntryType | 'all'
  brokenThumbs: ReadonlySet<string>
  thumbSrc: (entry: ShowcaseEntry) => string
}>()
const emit = defineEmits<{
  select: [type: ShowcaseEntryType | 'all']
  'image-error': [entry: ShowcaseEntry]
}>()
</script>

<style scoped>
.showcase-albums { min-width: 0; padding: var(--s-5) 0 var(--s-6); }
.albums-heading { display: flex; align-items: center; justify-content: space-between; gap: var(--s-3); margin-bottom: var(--s-4); }
.albums-kicker { color: var(--text-muted); font: 500 var(--fs-mono-xs) var(--font-mono); letter-spacing: .14em; }
.albums-heading h2 { margin: var(--s-1) 0 0; font-size: var(--fs-body-lg); font-weight: 600; }
.albums-all { display: inline-flex; align-items: center; gap: var(--s-2); min-height: 40px; padding: var(--s-2) var(--s-3); border: 1px solid var(--border-soft); border-radius: var(--r-pill); background: var(--bg-surface); color: var(--text-secondary); font: inherit; font-size: var(--fs-label); cursor: pointer; }
.albums-all[aria-pressed="true"] { color: var(--accent); background: var(--accent-soft); border-color: var(--accent); }
.albums-all .archive-icon { transform: rotate(-90deg); }
.albums-track { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(180px, calc((100% - var(--s-5) * 3) / 4)); gap: var(--s-5); overflow-x: auto; overscroll-behavior-inline: contain; padding: var(--s-2) var(--s-1) var(--s-3); scroll-snap-type: x proximity; }
.album-card { min-width: 0; padding: 0; border: 0; border-radius: var(--r-md); background: transparent; color: var(--text-primary); font: inherit; text-align: left; cursor: pointer; scroll-snap-align: start; }
.album-art { display: block; position: relative; margin: var(--s-1) var(--s-1) var(--s-3); aspect-ratio: 1.65; isolation: isolate; }
.album-art::before { content: ''; position: absolute; z-index: -1; inset: -5px 7px 5px; border: 1px solid var(--border-soft); border-radius: var(--r-lg); background: var(--bg-base); transform: rotate(-2deg); transition: transform var(--motion-hover); }
.album-cover { display: block; height: 100%; overflow: hidden; border: 2px solid var(--bg-surface); border-radius: var(--r-lg); background: var(--bg-base); box-shadow: var(--shadow-sm); }
.album-cover img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: center 28%; transition: transform var(--motion-hover); }
.album-placeholder { height: 100%; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: var(--s-2); color: var(--text-muted); font-size: var(--fs-label); }
.album-placeholder > .archive-icon { font-size: var(--fs-title); }
.album-card[aria-pressed="true"] .album-cover { outline: 2px solid var(--accent); outline-offset: 2px; }
.album-selected { position: absolute; bottom: var(--s-2); right: var(--s-2); display: grid; place-items: center; width: 26px; height: 26px; border: 1px solid var(--accent); border-radius: var(--r-pill); background: var(--bg-surface); color: var(--accent); }
.album-copy { display: flex; justify-content: space-between; align-items: baseline; gap: var(--s-2); padding-inline: var(--s-1); }
.album-copy strong { font-size: var(--fs-body); font-weight: 600; }
.album-copy > span { flex-shrink: 0; color: var(--text-secondary); font-size: var(--fs-label); font-variant-numeric: tabular-nums; }
.album-description { display: block; margin-top: var(--s-1); padding-inline: var(--s-1); color: var(--text-muted); font-size: var(--fs-label-xs); line-height: var(--lh-body); }
.album-card:focus-visible, .albums-all:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
@media (hover: hover) and (prefers-reduced-motion: no-preference) {
  html:not([data-reduced-motion="true"]) .album-card:hover .album-art::before { transform: translateY(-2px) rotate(-3deg); }
  html:not([data-reduced-motion="true"]) .album-card:hover .album-cover img { transform: scale(1.035); }
}
@media (max-width: 768px) { .albums-track { grid-auto-columns: minmax(175px, 42%); gap: var(--s-4); } .showcase-albums { padding-bottom: var(--s-4); } }
@media (prefers-reduced-motion: reduce) { .album-art::before, .album-cover img { transition: none; } }
</style>
