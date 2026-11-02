<template>
  <aside class="artist-reference" aria-label="画师参考样张">
    <strong class="reference-heading">画风参考</strong>
    <p v-if="!artists.length" class="reference-message">选择画师查看样张</p>
    <p v-else-if="assets.initialLoading.value" class="reference-message" role="status">正在读取参考样张…</p>
    <div v-else-if="assets.error.value && !assets.entries.value.length" class="reference-message" role="status">
      <span>参考样张暂时无法读取。</span>
      <button class="btn btn-quiet btn-sm" type="button" @click="reload">重新读取</button>
    </div>
    <div v-else class="reference-list">
      <div v-for="artist in artists" :key="artist.id" class="reference-item">
        <strong>{{ artist.cnName || artist.name }}</strong>
        <RouterLink v-for="sample in samplesFor(artist.id)" :key="sample.id" class="reference-image" :to="{ path: '/showcase', query: { scene: sample.id } }" :aria-label="`在参考画册查看${artist.cnName || artist.name}的样张`" @click="$emit('view')">
          <ShowcasePreviewSource :src="assets.imageUrl(sample.id)" v-slot="{ image, loaded, failed }">
            <img v-if="image.src && !failed" v-bind="image" :class="{ ready: loaded }" :alt="`${artist.cnName || artist.name}的未花画风样张`" loading="lazy" decoding="async" />
            <span v-else class="reference-fallback">预览暂不可用</span>
          </ShowcasePreviewSource>
        </RouterLink>
        <p v-if="!samplesFor(artist.id).length" class="reference-message">暂无该画师的参考样张。</p>
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue'
import { useShowcaseAssets } from '@/composables/scene/useShowcaseAssets'
import ShowcasePreviewSource from '@/components/showcase/ShowcasePreviewSource.vue'
import type { ArtistStyleOption } from '@/config/artistStyles'

const props = defineProps<{ artists: readonly ArtistStyleOption[]; active: boolean }>()
defineEmits<{ view: [] }>()
const assets = useShowcaseAssets()
const samples = computed(() => {
  const entries = new Map<string, Array<(typeof assets.entries.value)[number]>>()
  for (const entry of assets.entries.value) {
    if (entry.type !== 'artist' || !entry.artistId) continue
    const items = entries.get(entry.artistId) ?? []
    items.push(entry)
    entries.set(entry.artistId, items)
  }
  return entries
})
function samplesFor(id: string) { return samples.value.get(id) ?? [] }
function reload() { void assets.reload(true).catch(() => {}) }
watch(() => props.active, active => { if (active && !assets.initialLoading.value) reload() })
</script>

<style scoped>
.artist-reference { display:flex; flex-direction:column; gap:var(--s-3); min-width:0; min-height:0; padding:var(--s-3); overflow:auto; overscroll-behavior:contain; border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--bg-base); }
.reference-heading { color:var(--text-primary); font-size:var(--fs-label); }
.reference-list { display:grid; gap:var(--s-3); }
.reference-item { display:grid; gap:var(--s-2); min-width:0; color:var(--text-primary); font-size:var(--fs-label-sm); overflow-wrap:anywhere; }
.reference-message { display:grid; justify-items:start; gap:var(--s-2); margin:0; color:var(--text-secondary); font-size:var(--fs-label-sm); line-height:var(--lh-body); }
.reference-image { display:block; color:var(--text-primary); text-decoration:none; }
.reference-image img { display:block; width:100%; height:auto; max-height:calc(100dvh - 220px); object-fit:contain; border-radius:var(--r-md); background:var(--art-mat); opacity:0; transition:opacity var(--motion-surface) var(--ease-out); }
.reference-image img.ready { opacity:1; }
.reference-fallback { display:grid; min-height:100px; place-items:center; border-radius:var(--r-md); background:var(--bg-elevated); color:var(--text-secondary); }
.reference-image:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
@media (forced-colors:active) {
  .artist-reference { background:Canvas; color:CanvasText; border-color:CanvasText; }
  .reference-image:focus-visible { outline:2px solid Highlight; }
}
@media (prefers-reduced-motion:reduce) { :root:not([data-motion='full']) .reference-image img { transition:none; } }
:root:is([data-motion='reduce'],[data-motion='reduced']) .reference-image img { transition:none; }
</style>
