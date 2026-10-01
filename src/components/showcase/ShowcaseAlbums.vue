<template>
  <section v-if="albums.length" class="showcase-albums tw:min-w-0" aria-labelledby="showcaseAlbumsTitle">
    <div class="albums-heading tw:flex tw:items-center tw:justify-between tw:gap-s-3 tw:mb-s-4">
      <div><span class="albums-kicker tw:text-muted">THE COLLECTIONS</span><h2 id="showcaseAlbumsTitle">按册翻阅</h2></div>
      <span class="albums-count">{{ albums.length }} 本画册</span>
    </div>
    <div class="albums-track tw:grid tw:gap-s-5">
      <button v-for="album in albums" :key="album.type" class="album-card tw:min-w-0 tw:p-0 tw:rounded-md tw:text-primary tw:text-left tw:cursor-pointer" type="button"
        :data-album-id="album.type" :aria-pressed="selected === album.type" :aria-label="`${album.title}，${album.count} 幅样张`" @click="emit('select', album.type)">
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
.showcase-albums { padding:var(--s-2) 0 var(--s-6); }
.albums-kicker { font: 500 var(--fs-mono-xs) var(--font-mono); letter-spacing: .14em; }
.albums-heading h2 { margin: var(--s-1) 0 0; @apply tw:text-body-lg tw:font-semibold; }
.albums-count { @apply tw:text-muted tw:text-label; }
.albums-track { grid-template-columns:repeat(auto-fill,minmax(min(100%,15rem),1fr)); padding:var(--s-2) var(--s-1) var(--s-3); }
.album-card { border: 0; background: transparent; font: inherit; scroll-snap-align: start; }
.album-art { margin: var(--s-1) var(--s-1) var(--s-3); aspect-ratio: 1.65; }
.album-art::before { content: ''; @apply tw:absolute; z-index: -1; inset: -5px 7px 5px; border: 1px solid var(--border-soft); @apply tw:rounded-lg; background: var(--bg-base); transform: rotate(-2deg); }
.album-cover { border: 2px solid var(--bg-surface); background: var(--bg-base); box-shadow: var(--shadow-sm); }
.album-cover :deep(img) { @apply tw:block tw:w-full tw:h-full tw:object-cover; object-position: center 28%; }
.album-placeholder > .archive-icon { @apply tw:text-title; }
.album-card[aria-pressed="true"] .album-cover { outline: 2px solid var(--accent); outline-offset: 2px; }
.album-selected { place-items: center; border: 1px solid var(--accent); background: var(--bg-surface); }
.album-copy { padding-inline: var(--s-1); }
.album-copy strong { @apply tw:text-body tw:font-semibold; }
.album-copy > span { @apply tw:shrink-0 tw:text-secondary tw:text-label; font-variant-numeric: tabular-nums; }
.album-description { padding-inline: var(--s-1); }
.album-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
@media (hover:hover) and (pointer:fine) { .album-card:hover .album-copy strong { color:var(--accent); } }
@media (max-width: 768px) { .albums-track { @apply tw:gap-s-4; } .showcase-albums { @apply tw:pb-s-4; } }
</style>
