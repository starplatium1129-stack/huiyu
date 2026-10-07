<template>
  <section v-if="albums.length" ref="root" class="gallery-albums tw:mb-s-4" :aria-label="characters ? '角色画册' : '我的画册'">
    <header class="gallery-albums-heading tw:mb-s-3">
      <h2>{{ characters ? '角色画册' : '我的画册' }} <span>{{ albums.length }} {{ characters ? '位角色' : '本' }}</span></h2>
    </header>
    <div class="gallery-albums-track artwork-albums-track" role="group" :aria-label="characters ? '按角色翻阅作品' : '按画册翻阅作品'">
      <div v-for="album in albums" :key="album.id" class="gallery-album-entry">
      <button class="gallery-album artwork-album tw:rounded-lg" type="button" :aria-pressed="selectedId === album.id"
        :data-album-id="album.id" :aria-label="`${album.title}，${album.count} 幅作品`" @click="emit('select', album.id)">
        <span class="gallery-album-cover artwork-album-cover" :data-covers="album.covers.length" :class="{ 'is-empty': !album.count }" aria-hidden="true">
          <span v-for="cover in album.covers" :key="cover.id" class="gallery-album-picture artwork-album-picture tw:text-secondary">
            <img v-if="resolvedUrls[cover.id] && failedUrls[cover.id] !== resolvedUrls[cover.id]" :key="resolvedUrls[cover.id]" :src="resolvedUrls[cover.id]" :crossorigin="runtimeResourceCors()"
              alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" @error="markCoverError(cover.id, $event)" />
            <ArchiveIcon v-else name="image" />
          </span>
          <span v-if="!album.covers.length" class="gallery-album-placeholder tw:flex tw:items-center tw:justify-center tw:flex-col tw:gap-s-2 tw:text-secondary"><ArchiveIcon name="gallery" /><span>{{ album.count ? '打开画册' : '空画册' }}</span></span>
        </span>
        <span class="gallery-album-caption artwork-album-caption"><span><strong>{{ album.title }}</strong><small>{{ album.count }} 幅作品 · {{ album.kind === 'smart' ? '智能画册' : album.kind === 'character' ? '角色归集' : '精选画册' }}</small></span><ArchiveIcon :name="selectedId === album.id ? 'success' : 'chevron-down'" /></span>
      </button>
      <template v-if="album.kind === 'smart'"><p class="gallery-album-rule">{{ album.ruleSummary }}</p><div class="gallery-album-actions"><button type="button" :disabled="busy" :aria-label="`编辑智能画册：${album.title}`" @click="emit('edit',album.id)">编辑条件</button><button type="button" :disabled="busy" :aria-label="`移除智能画册：${album.title}`" @click="emit('remove',album.id)">移除画册</button></div></template>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, reactive, ref, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { resolveRuntimeUrl, runtimeResourceCors } from '@/platform/runtimeUrl'
import type { GalleryProjectAlbum } from '@/composables/gallery/useGalleryProjectAlbums'
import '@/assets/css/album-cards.css'

const props = withDefaults(defineProps<{ albums: readonly GalleryProjectAlbum[]; selectedId: string; characters?: boolean; busy?: boolean }>(), { characters: false, busy: false })
const emit = defineEmits<{ select: [id: string]; edit: [id: string]; remove: [id: string]; visible: [ids: string[]] }>()
const root = ref<HTMLElement | null>(null)
const visibleIds = new Set<string>()
let observer: IntersectionObserver | null = null
let disposed = false, observationVersion = 0
async function observeCovers() {
  const version = ++observationVersion
  observer?.disconnect(); visibleIds.clear(); emit('visible', [])
  await nextTick()
  if (disposed || version !== observationVersion || typeof IntersectionObserver === 'undefined') return
  observer = new IntersectionObserver(entries => {
    if (disposed || version !== observationVersion) return
    for (const entry of entries) {
      const id = (entry.target as HTMLElement).dataset.albumId!
      if (entry.isIntersecting) visibleIds.add(id)
      else visibleIds.delete(id)
    }
    emit('visible', [...visibleIds])
  }, { rootMargin: '300px 0px' })
  root.value?.querySelectorAll('[data-album-id]').forEach(element => observer!.observe(element))
}
onMounted(observeCovers)
watch(() => JSON.stringify(props.albums.map(album => album.id)), observeCovers)
onBeforeUnmount(() => { disposed = true; observationVersion++; observer?.disconnect(); observer = null })
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
.gallery-albums-heading h2 { @apply tw:flex tw:items-baseline tw:gap-s-2 tw:text-primary; margin:0; font:600 var(--fs-body-sm) var(--font-sans); }
.gallery-albums-heading h2 span { @apply tw:text-secondary; font:400 var(--fs-label-sm) var(--font-sans); }
.gallery-album-entry { min-width:0; }
.gallery-album-cover.is-empty { aspect-ratio:auto; min-height:96px; }
.gallery-album-picture > .archive-icon { @apply tw:w-[26px] tw:h-[26px]; }
.gallery-album-placeholder { background:var(--bg-surface); font:400 var(--fs-label-xs) var(--font-sans); }
.gallery-album-placeholder > .archive-icon { @apply tw:w-[24px] tw:h-[24px]; }
.gallery-album-rule { @apply tw:text-secondary tw:text-label-xs tw:leading-body; margin:0 0 var(--s-2); display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; overflow-wrap:anywhere; }
.gallery-album-actions { @apply tw:flex tw:gap-s-2; }
.gallery-album-actions button { @apply tw:text-secondary tw:text-label-sm tw:cursor-pointer; min-height:32px; padding:var(--s-1) var(--s-2); background:var(--bg-surface); border:1px solid var(--border-soft); border-radius:var(--r-md); }
.gallery-album-actions button:hover { color:var(--accent); border-color:var(--accent); }
.gallery-album-actions button:disabled { color:var(--text-disabled); }
.gallery-albums button:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
</style>
