<template>
  <section v-if="albums.length" class="gallery-albums" aria-label="项目相册">
    <header class="gallery-albums-heading">
      <div><span class="gallery-albums-kicker">STORIES IN ALBUMS</span><h2>成册的故事 <span>{{ albums.length }} 本</span></h2></div>
      <button v-if="selectedId" class="gallery-albums-all" type="button" @click="emit('select', '')">全部项目<ArchiveIcon name="chevron-down" /></button>
      <p v-else>选一本，翻阅你的创作</p>
    </header>
    <div class="gallery-albums-track" role="group" aria-label="按项目翻阅作品">
      <button v-for="album in albums" :key="album.id" class="gallery-album" type="button" :aria-pressed="selectedId === album.id"
        :aria-label="`${album.title}，${album.count} 幅作品`" @click="emit('select', selectedId === album.id ? '' : album.id)">
        <span class="gallery-album-cover" :data-covers="album.covers.length" aria-hidden="true">
          <span v-for="cover in album.covers" :key="cover.id" class="gallery-album-picture">
            <img v-if="resolvedUrls[cover.id] && failedUrls[cover.id] !== resolvedUrls[cover.id]" :key="resolvedUrls[cover.id]" :src="resolvedUrls[cover.id]" :crossorigin="runtimeResourceCors()"
              alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" @error="markCoverError(cover.id, $event)" />
            <ArchiveIcon v-else name="image" />
          </span>
          <span v-if="!album.covers.length" class="gallery-album-placeholder"><ArchiveIcon name="gallery" /><span>打开相册，翻阅作品</span></span>
        </span>
        <span class="gallery-album-caption"><span><strong>{{ album.title }}</strong><small>{{ album.count }} 幅作品</small></span><ArchiveIcon :name="selectedId === album.id ? 'success' : 'chevron-down'" /></span>
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
.gallery-albums { margin-bottom: var(--s-6); }
.gallery-albums-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--s-4); margin-bottom: var(--s-4); }
.gallery-albums-kicker { color: var(--text-secondary); font: 500 var(--fs-mono-xs) var(--font-mono); letter-spacing: .12em; }
.gallery-albums-heading h2 { display: flex; align-items: baseline; gap: var(--s-3); margin: var(--s-1) 0 0; color: var(--text-primary); font: 600 var(--fs-body-lg) var(--font-display); }
.gallery-albums-heading h2 span, .gallery-albums-heading p { color: var(--text-secondary); font: 400 var(--fs-label-sm) var(--font-sans); }
.gallery-albums-heading p { margin: 0; }
.gallery-albums-all { display: inline-flex; align-items: center; gap: var(--s-2); min-height: 40px; padding: 0 var(--s-2); border: 0; border-radius: var(--r-sm); background: transparent; color: var(--accent); font: 600 var(--fs-label-sm) var(--font-sans); cursor: pointer; }
.gallery-albums-all .archive-icon { transform: rotate(-90deg); }
.gallery-albums-track { display: flex; gap: var(--s-5); overflow-x: auto; padding: var(--s-2) var(--s-1) var(--s-3); margin: calc(-1 * var(--s-2)) calc(-1 * var(--s-1)) 0; scroll-snap-type: x proximity; scrollbar-width: thin; scrollbar-color: var(--border-soft) transparent; }
.gallery-album { flex: 0 0 clamp(180px, 19vw, 250px); min-width: 0; padding: 0; border: 0; border-radius: var(--r-lg); background: transparent; color: var(--text-primary); text-align: left; cursor: pointer; scroll-snap-align: start; }
.gallery-album-cover { position: relative; display: grid; grid-template-columns: 1fr; aspect-ratio: 1.55; gap: 3px; padding: 4px; border: 1px solid var(--border-soft); border-radius: var(--r-lg); background: var(--bg-surface); overflow: hidden; box-shadow: var(--shadow-sm); transition: transform var(--motion-hover); }
.gallery-album-cover[data-covers="2"] { grid-template-columns: 1fr 1fr; }
.gallery-album-cover[data-covers="3"] { grid-template-columns: 1.6fr 1fr; grid-template-rows: 1fr 1fr; }
.gallery-album-cover[data-covers="3"] .gallery-album-picture:first-child { grid-row: span 2; }
.gallery-album-picture { display: grid; place-items: center; min-height: 0; min-width: 0; overflow: hidden; border-radius: var(--r-sm); background: var(--bg-elevated); color: var(--text-secondary); }
.gallery-album-picture img { display: block; width: 100%; height: 100%; min-height: 0; object-fit: cover; }
.gallery-album-picture > .archive-icon { width: 26px; height: 26px; }
.gallery-album-placeholder { display: flex; align-items: center; justify-content: center; flex-direction: column; gap: var(--s-3); border-radius: var(--r-md); background: var(--bg-base); color: var(--text-secondary); font: 400 var(--fs-label-xs) var(--font-sans); }
.gallery-album-placeholder > .archive-icon { width: 32px; height: 32px; }
.gallery-album-caption { display: flex; align-items: center; justify-content: space-between; gap: var(--s-3); padding: var(--s-3) var(--s-1) var(--s-1); }
.gallery-album-caption > span { min-width: 0; }
.gallery-album-caption strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 600 var(--fs-body-sm) var(--font-sans); }
.gallery-album-caption small { display: block; margin-top: var(--s-1); color: var(--text-secondary); font: 400 var(--fs-label-xs) var(--font-sans); }
.gallery-album-caption > .archive-icon { color: var(--accent); transform: rotate(-90deg); }
.gallery-album[aria-pressed="true"] .gallery-album-cover { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
.gallery-album[aria-pressed="true"] .gallery-album-caption strong { color: var(--accent); }
.gallery-album[aria-pressed="true"] .gallery-album-caption > .archive-icon { transform: none; }
.gallery-albums button:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
@media (hover: hover) and (prefers-reduced-motion: no-preference) { html:not([data-reduced-motion="true"]) .gallery-album:hover .gallery-album-cover { transform: translateY(-3px); } }
@media (max-width: 600px) { .gallery-albums { margin-bottom: var(--s-4); } .gallery-albums-track { gap: var(--s-4); } .gallery-albums-heading p { display: none; } .gallery-album { flex-basis: 180px; } }
@media (prefers-reduced-motion: reduce) { .gallery-album-cover { transition: none; } }
</style>
