<template>
  <section v-if="albums.length" class="gallery-albums tw:mb-s-6" aria-label="项目相册">
    <header class="gallery-albums-heading tw:flex tw:items-end tw:justify-between tw:gap-s-4 tw:mb-s-4">
      <div><span class="gallery-albums-kicker tw:text-secondary">STORIES IN ALBUMS</span><h2>成册的故事 <span>{{ albums.length }} 本</span></h2></div>
      <button v-if="selectedId" class="gallery-albums-all tw:inline-flex tw:items-center tw:gap-s-2 tw:min-h-[40px] tw:rounded-sm tw:text-accent tw:cursor-pointer" type="button" @click="emit('select', '')">全部项目<ArchiveIcon name="chevron-down" /></button>
      <p v-else>选一本，翻阅你的创作</p>
    </header>
    <div class="gallery-albums-track tw:flex tw:gap-s-5 tw:overflow-x-auto" role="group" aria-label="按项目翻阅作品">
      <button v-for="album in albums" :key="album.id" class="gallery-album tw:min-w-0 tw:p-0 tw:rounded-lg tw:text-primary tw:text-left tw:cursor-pointer" type="button" :aria-pressed="selectedId === album.id"
        :aria-label="`${album.title}，${album.count} 幅作品`" @click="emit('select', selectedId === album.id ? '' : album.id)">
        <span class="gallery-album-cover tw:relative tw:grid tw:gap-[3px] tw:p-[4px] tw:rounded-lg tw:overflow-hidden" :data-covers="album.covers.length" aria-hidden="true">
          <span v-for="cover in album.covers" :key="cover.id" class="gallery-album-picture tw:grid tw:min-h-0 tw:min-w-0 tw:overflow-hidden tw:rounded-sm tw:text-secondary">
            <img v-if="resolvedUrls[cover.id] && failedUrls[cover.id] !== resolvedUrls[cover.id]" :key="resolvedUrls[cover.id]" :src="resolvedUrls[cover.id]" :crossorigin="runtimeResourceCors()"
              alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" @error="markCoverError(cover.id, $event)" />
            <ArchiveIcon v-else name="image" />
          </span>
          <span v-if="!album.covers.length" class="gallery-album-placeholder tw:flex tw:items-center tw:justify-center tw:flex-col tw:gap-s-3 tw:rounded-md tw:text-secondary"><ArchiveIcon name="gallery" /><span>打开相册，翻阅作品</span></span>
        </span>
        <span class="gallery-album-caption tw:flex tw:items-center tw:justify-between tw:gap-s-3"><span><strong>{{ album.title }}</strong><small>{{ album.count }} 幅作品</small></span><ArchiveIcon :name="selectedId === album.id ? 'success' : 'chevron-down'" /></span>
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { resolveRuntimeUrl, runtimeResourceCors } from '@/platform/runtimeUrl'
import type { GalleryProjectAlbum } from '@/composables/gallery/useGalleryProjectAlbums'

const props = defineProps<{ albums: readonly GalleryProjectAlbum[]; selectedId: string }>()
const emit = defineEmits<{ select: [id: string] }>()
const failedUrls = reactive<Record<string, string>>({})
const resolvedUrls = computed<Record<string, string>>(() => Object.fromEntries(props.albums.flatMap(album => album.covers.map(cover => [cover.id, resolveRuntimeUrl(cover.src)]))))
// Observe the disconnected state synchronously so even a same-address reconnect retries failed covers.
watch(resolvedUrls, (urls, previous) => {
  for (const id of Object.keys(failedUrls)) if (urls[id] !== previous[id]) delete failedUrls[id]
}, { flush: 'sync' })
function markCoverError(id: string | number, event: Event) {
  const src = (event.currentTarget as HTMLImageElement).getAttribute('src')
  if (src && src === resolvedUrls.value[id]) failedUrls[id] = src
}
</script>

<style scoped>
@reference "../../assets/css/tailwind.css";
.gallery-albums-kicker { font: 500 var(--fs-mono-xs) var(--font-mono); letter-spacing: .12em; }
.gallery-albums-heading h2 { @apply tw:flex tw:items-baseline tw:gap-s-3; margin: var(--s-1) 0 0; @apply tw:text-primary; font: 600 var(--fs-body-lg) var(--font-display); }
.gallery-albums-heading h2 span, .gallery-albums-heading p { @apply tw:text-secondary; font: 400 var(--fs-label-sm) var(--font-sans); }
.gallery-albums-heading p { @apply tw:m-0; }
.gallery-albums-all { padding: 0 var(--s-2); border: 0; background: transparent; font: 600 var(--fs-label-sm) var(--font-sans); }
.gallery-albums-all .archive-icon { transform: rotate(-90deg); }
.gallery-albums-track { padding: var(--s-2) var(--s-1) var(--s-3); margin: calc(-1 * var(--s-2)) calc(-1 * var(--s-1)) 0; scroll-snap-type: x proximity; scrollbar-width: thin; scrollbar-color: var(--border-soft) transparent; }
.gallery-album { flex: 0 0 clamp(180px, 19vw, 250px); border: 0; background: transparent; scroll-snap-align: start; }
.gallery-album-cover { grid-template-columns: 1fr; aspect-ratio: 1.55; border: 1px solid var(--border-soft); background: var(--bg-surface); box-shadow: var(--shadow-sm); transition: transform var(--motion-hover); }
.gallery-album-cover[data-covers="2"] { grid-template-columns: 1fr 1fr; }
.gallery-album-cover[data-covers="3"] { grid-template-columns: 1.6fr 1fr; grid-template-rows: 1fr 1fr; }
.gallery-album-cover[data-covers="3"] .gallery-album-picture:first-child { grid-row: span 2; }
.gallery-album-picture { place-items: center; background: var(--bg-elevated); }
.gallery-album-picture img { @apply tw:block tw:w-full tw:h-full tw:min-h-0 tw:object-cover; }
.gallery-album-picture > .archive-icon { @apply tw:w-[26px] tw:h-[26px]; }
.gallery-album-placeholder { background: var(--bg-base); font: 400 var(--fs-label-xs) var(--font-sans); }
.gallery-album-placeholder > .archive-icon { @apply tw:w-[32px] tw:h-[32px]; }
.gallery-album-caption { padding: var(--s-3) var(--s-1) var(--s-1); }
.gallery-album-caption > span { @apply tw:min-w-0; }
.gallery-album-caption strong { @apply tw:block tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap; font: 600 var(--fs-body-sm) var(--font-sans); }
.gallery-album-caption small { @apply tw:block tw:mt-s-1 tw:text-secondary; font: 400 var(--fs-label-xs) var(--font-sans); }
.gallery-album-caption > .archive-icon { @apply tw:text-accent; transform: rotate(-90deg); }
.gallery-album[aria-pressed="true"] .gallery-album-cover { @apply tw:border-accent; box-shadow: 0 0 0 2px var(--accent-soft); }
.gallery-album[aria-pressed="true"] .gallery-album-caption strong { @apply tw:text-accent; }
.gallery-album[aria-pressed="true"] .gallery-album-caption > .archive-icon { transform: none; }
.gallery-albums button:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
@media (hover: hover) and (prefers-reduced-motion: no-preference) { html:not([data-reduced-motion="true"]) .gallery-album:hover .gallery-album-cover { transform: translateY(-3px); } }
@media (max-width: 600px) { .gallery-albums { @apply tw:mb-s-4; } .gallery-albums-track { @apply tw:gap-s-4; } .gallery-albums-heading p { @apply tw:hidden; } .gallery-album { flex-basis: 180px; } }
@media (prefers-reduced-motion: reduce) { .gallery-album-cover { transition: none; } }
</style>
