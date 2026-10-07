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
            <RuntimeImage :src="thumbSrc(cover)" alt="" loading="lazy" decoding="async">
              <template #fallback><span class="album-placeholder tw:flex tw:items-center tw:justify-center tw:text-secondary"><ArchiveIcon name="image" /></span></template>
            </RuntimeImage>
          </span>
          <span v-if="!album.covers.length" class="album-placeholder tw:flex tw:items-center tw:justify-center tw:flex-col tw:gap-s-2 tw:text-secondary tw:text-label"><ArchiveIcon name="gallery" /><span>翻开这本画册</span></span>
        </span>
        <span class="album-copy artwork-album-caption"><span><strong>{{ album.title }}</strong><small>{{ album.count }} 幅样张 · {{ album.description }}</small></span><ArchiveIcon :name="selected === album.id ? 'success' : 'chevron-down'" /></span>
      </button>
      </div>
    </section>
  </section>
</template>

<script setup lang="ts">
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { computed } from 'vue'
import type { ShowcaseAlbum } from '@/composables/showcase/useShowcaseAlbums'
import RuntimeImage from '@/components/visual/RuntimeImage.vue'
import type { ShowcaseEntry } from '@/utils/showcaseManifest'
import '@/assets/css/album-cards.css'

const props = defineProps<{
  albums: ShowcaseAlbum[]
  selected: string
  thumbSrc: (entry: ShowcaseEntry) => string
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
</style>
