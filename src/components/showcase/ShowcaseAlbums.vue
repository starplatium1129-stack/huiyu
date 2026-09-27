<template>
  <section v-if="albums.length" class="showcase-albums tw:min-w-0" aria-labelledby="showcaseAlbumsTitle">
    <div class="albums-heading tw:flex tw:items-center tw:justify-between tw:gap-s-3 tw:mb-s-4">
      <div><span class="albums-kicker tw:text-muted">THE COLLECTIONS</span><h2 id="showcaseAlbumsTitle">按册翻阅</h2></div>
      <button class="albums-all tw:inline-flex tw:items-center tw:gap-s-2 tw:min-h-[40px] tw:rounded-pill tw:text-secondary tw:cursor-pointer" type="button" :aria-pressed="selected === 'all'" @click="emit('select', 'all')">全部画册 <ArchiveIcon name="chevron-down" /></button>
    </div>
    <div class="albums-track tw:grid tw:gap-s-5 tw:overflow-x-auto">
      <button v-for="album in albums" :key="album.type" class="album-card tw:min-w-0 tw:p-0 tw:rounded-md tw:text-primary tw:text-left tw:cursor-pointer" type="button"
        :aria-pressed="selected === album.type" :aria-label="`${album.title}，${album.count} 幅样张`" @click="emit('select', selected === album.type ? 'all' : album.type)">
        <span class="album-art tw:block tw:relative tw:isolate">
          <span class="album-cover tw:block tw:h-full tw:overflow-hidden tw:rounded-lg">
            <RuntimeImage :src="album.cover ? thumbSrc(album.cover) : ''" alt="" loading="lazy" decoding="async">
              <template #fallback><span class="album-placeholder tw:h-full tw:flex tw:items-center tw:justify-center tw:flex-col tw:gap-s-2 tw:text-muted tw:text-label"><ArchiveIcon name="gallery" /><span>翻开这本画册</span></span></template>
            </RuntimeImage>
          </span>
          <span v-if="selected === album.type" class="album-selected tw:absolute tw:bottom-s-2 tw:right-s-2 tw:grid tw:w-[26px] tw:h-[26px] tw:rounded-pill tw:text-accent"><ArchiveIcon name="success" /></span>
        </span>
        <span class="album-copy tw:flex tw:justify-between tw:items-baseline tw:gap-s-2"><strong>{{ album.title }}</strong><span>{{ album.count }} 幅</span></span>
        <span class="album-description tw:block tw:mt-s-1 tw:text-muted tw:text-label-xs tw:leading-body">{{ album.description }}</span>
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import type { ShowcaseAlbum } from '@/composables/showcase/useShowcaseAlbums'
import RuntimeImage from '@/components/visual/RuntimeImage.vue'
import type { ShowcaseEntry, ShowcaseEntryType } from '@/utils/showcaseManifest'

defineProps<{
  albums: ShowcaseAlbum[]
  selected: ShowcaseEntryType | 'all'
  thumbSrc: (entry: ShowcaseEntry) => string
}>()
const emit = defineEmits<{
  select: [type: ShowcaseEntryType | 'all']
}>()
</script>

<style scoped>
@reference "../../assets/css/tailwind.css";
.showcase-albums { padding: var(--s-5) 0 var(--s-6); }
.albums-kicker { font: 500 var(--fs-mono-xs) var(--font-mono); letter-spacing: .14em; }
.albums-heading h2 { margin: var(--s-1) 0 0; @apply tw:text-body-lg tw:font-semibold; }
.albums-all { padding: var(--s-2) var(--s-3); border: 1px solid var(--border-soft); background: var(--bg-surface); font: inherit; @apply tw:text-label; }
.albums-all[aria-pressed="true"] { @apply tw:text-accent; background: var(--accent-soft); @apply tw:border-accent; }
.albums-all .archive-icon { transform: rotate(-90deg); }
.albums-track { grid-auto-flow: column; grid-auto-columns: minmax(180px, calc((100% - var(--s-5) * 3) / 4)); overscroll-behavior-inline: contain; padding: var(--s-2) var(--s-1) var(--s-3); scroll-snap-type: x proximity; }
.album-card { border: 0; background: transparent; font: inherit; scroll-snap-align: start; }
.album-art { margin: var(--s-1) var(--s-1) var(--s-3); aspect-ratio: 1.65; }
.album-art::before { content: ''; @apply tw:absolute; z-index: -1; inset: -5px 7px 5px; border: 1px solid var(--border-soft); @apply tw:rounded-lg; background: var(--bg-base); transform: rotate(-2deg); transition: transform var(--motion-hover); }
.album-cover { border: 2px solid var(--bg-surface); background: var(--bg-base); box-shadow: var(--shadow-sm); }
.album-cover :deep(img) { @apply tw:block tw:w-full tw:h-full tw:object-cover; object-position: center 28%; transition: transform var(--motion-hover); }
.album-placeholder > .archive-icon { @apply tw:text-title; }
.album-card[aria-pressed="true"] .album-cover { outline: 2px solid var(--accent); outline-offset: 2px; }
.album-selected { place-items: center; border: 1px solid var(--accent); background: var(--bg-surface); }
.album-copy { padding-inline: var(--s-1); }
.album-copy strong { @apply tw:text-body tw:font-semibold; }
.album-copy > span { @apply tw:shrink-0 tw:text-secondary tw:text-label; font-variant-numeric: tabular-nums; }
.album-description { padding-inline: var(--s-1); }
.album-card:focus-visible, .albums-all:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
@media (hover: hover) and (prefers-reduced-motion: no-preference) {
  html:not([data-reduced-motion="true"]) .album-card:hover .album-art::before { transform: translateY(-2px) rotate(-3deg); }
  html:not([data-reduced-motion="true"]) .album-card:hover .album-cover :deep(img) { transform: scale(1.035); }
}
@media (max-width: 768px) { .albums-track { grid-auto-columns: minmax(175px, 42%); @apply tw:gap-s-4; } .showcase-albums { @apply tw:pb-s-4; } }
@media (prefers-reduced-motion: reduce) { .album-art::before, .album-cover :deep(img) { transition: none; } }
</style>
