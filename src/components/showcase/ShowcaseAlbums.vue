<template>
  <section v-if="albums.length" class="showcase-albums tw:min-w-0" aria-labelledby="showcaseAlbumsTitle">
    <div class="albums-heading tw:flex tw:items-center tw:justify-between tw:gap-s-3 tw:mb-s-4">
      <div><span class="albums-kicker tw:text-muted">THE COLLECTIONS</span><h2 id="showcaseAlbumsTitle">按册翻阅</h2></div>
      <span class="albums-count">{{ albums.length }} 本画册</span>
    </div>
    <section v-for="group in groups" :key="group.id" class="album-group" :aria-label="group.title">
      <h3>{{ group.title }} <span>{{ group.albums.length }} 本</span></h3>
      <div class="albums-track artwork-albums-track">
      <button v-for="album in group.albums" :key="album.id" class="album-card artwork-album tw:rounded-lg" type="button"
        :data-album-id="album.id" :aria-pressed="selected === album.id" :aria-label="`${album.title}，${album.count} 幅样张`" @click="emit('select', album.id)">
        <span class="album-cover artwork-album-cover" :data-covers="album.covers.length" aria-hidden="true">
          <span v-for="cover in album.covers" :key="cover.id" class="album-picture artwork-album-picture">
            <ShowcasePreviewSource :src="thumbSrc(cover)" :full-src="imageSrc(cover)" v-slot="{ image, failed, preview, previewReady }">
              <img v-if="image.src && !failed" v-bind="image" alt="" loading="lazy" decoding="async" />
              <span v-else class="album-placeholder tw:flex tw:items-center tw:justify-center tw:text-secondary"><ArchiveIcon name="image" /></span>
              <img v-if="preview.src && !failed" v-bind="preview" class="album-cover-hd" :class="{ 'is-ready': previewReady }" alt="" decoding="async" draggable="false" />
            </ShowcasePreviewSource>
          </span>
          <span v-if="!album.covers.length" class="album-placeholder tw:flex tw:items-center tw:justify-center tw:flex-col tw:gap-s-2 tw:text-secondary tw:text-label"><ArchiveIcon name="gallery" /><span>翻开这本画册</span></span>
        </span>
        <span class="album-copy artwork-album-caption"><span><strong>{{ album.title }}</strong><small>{{ album.count }} 幅样张 · {{ album.description }}</small></span><span class="artwork-album-mark" aria-hidden="true"><ArchiveIcon name="chevron-down" /><ArchiveIcon name="success" /></span></span>
      </button>
      </div>
    </section>
  </section>
</template>

<script setup lang="ts">
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { computed } from 'vue'
import type { ShowcaseAlbum } from '@/composables/showcase/useShowcaseAlbums'
import ShowcasePreviewSource from './ShowcasePreviewSource.vue'
import type { ShowcaseEntry } from '@/utils/showcaseManifest'
import '@/assets/css/album-cards.css'

const props = defineProps<{
  albums: ShowcaseAlbum[]
  selected: string
  thumbSrc: (entry: ShowcaseEntry) => string
  imageSrc: (entry: ShowcaseEntry) => string
}>()
const emit = defineEmits<{
  select: [id: string]
}>()
const groups = computed(() => [
  { id: 'overview', title: '综合画册' }, { id: 'theme', title: '场景主题' }, { id: 'franchise', title: '作品系列' },
].map(group => ({ ...group, albums: props.albums.filter(album => album.group === group.id) })).filter(group => group.albums.length))
</script>

<style scoped>
@reference "../../assets/css/tailwind.css";
.showcase-albums { padding:var(--s-2) 0 var(--s-6); }
.albums-kicker { font: 500 var(--fs-mono-xs) var(--font-mono); letter-spacing: .14em; }
.albums-heading h2 { margin: var(--s-1) 0 0; @apply tw:text-body-lg tw:font-semibold; }
.albums-count { @apply tw:text-muted tw:text-label; }
.album-group + .album-group { margin-top:var(--s-6); }
.album-group h3 { margin:0 0 var(--s-3); color:var(--text-primary); font:600 var(--fs-body-sm) var(--font-sans); }
.album-group h3 span { margin-left:var(--s-2); color:var(--text-secondary); font:400 var(--fs-label-sm) var(--font-sans); }
.album-placeholder > .archive-icon { @apply tw:text-title; }
.album-picture img.album-cover-hd { position:absolute; inset:0; opacity:0; pointer-events:none; transition:opacity var(--motion-surface) var(--ease-out); }
.album-picture img.album-cover-hd.is-ready { opacity:1; }
@media (prefers-reduced-motion:reduce) { :global(:root:not([data-motion='full'])) .album-picture img.album-cover-hd { transition:none; } }
:global(:root:is([data-motion='reduce'],[data-motion='reduced'])) .album-picture img.album-cover-hd { transition:none; }
</style>
