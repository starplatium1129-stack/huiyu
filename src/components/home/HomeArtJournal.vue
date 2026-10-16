<template>
  <section v-if="scenes.length" ref="section" class="art-journal container" aria-labelledby="journal-title" data-reveal @focusin="activateImages">
    <header class="journal-heading tw:flex tw:justify-between tw:gap-s-5 tw:mb-s-4">
      <div><span class="eyebrow">CG JOURNAL / 画里的日常</span><h2 id="journal-title">在喜欢的世界，多停留一会。</h2></div>
      <div class="journal-actions">
        <button v-if="canRefresh" type="button" class="journal-more journal-refresh" :aria-disabled="loading" :aria-busy="loading" aria-controls="journal-spread" @click="!loading && emit('refresh')"><ArchiveIcon name="refresh" />{{ loading ? '正在换画…' : '换一组' }}</button>
        <RouterLink to="/showcase" class="journal-more">翻阅参考画册 <ArchiveIcon name="image" /></RouterLink>
      </div>
    </header>
    <p v-if="error" class="journal-error" role="status">{{ error }}</p>
    <div id="journal-spread" ref="listRoot" class="journal-spread tw:grid" :aria-busy="loading">
      <RuntimeImage v-for="(scene, index) in scenes.slice(0, 3)" :key="scene.id" :src="imagesReady ? scene.image || '/scene-showcase/images/' + scene.id + '.jpg' : undefined" v-slot="{ image, failed }">
      <RouterLink class="journal-entry" :class="{ lead: index === 0 }" :data-list-key="scene.id" :data-sensitive="scene.rating === 'R18' || scene.mature" :to="failed ? scene.fallbackTo : '/showcase?scene=' + encodeURIComponent(scene.id)">
        <div class="journal-art tw:relative tw:overflow-hidden tw:rounded-xl"><template v-if="image.src && !failed"><img v-bind="image" :alt="scene.title" width="1024" height="1344" loading="lazy" decoding="async" /><SensitivePreviewVeil v-if="scene.rating === 'R18' || scene.mature" :src="image.src" :crossorigin="image.crossorigin" /></template><span v-else class="journal-missing tw:flex tw:h-full tw:flex-col tw:items-center tw:justify-center tw:gap-s-2 tw:p-s-4 tw:text-secondary tw:text-body-sm tw:text-center">{{ imagesReady ? '样张暂未连接' : '正在载入样张' }}<span>先看看这一幕的故事与设定</span></span><CardEdgeLight /></div>
        <div class="journal-caption tw:min-w-0"><span class="journal-category tw:text-accent tw:text-label-xs">{{ scene.category || '角色片刻' }}</span><h3>{{ scene.title }}</h3><p>{{ excerpt(scene.story) }}</p><span class="journal-read tw:inline-flex tw:items-center tw:gap-s-3 tw:text-label-sm tw:text-secondary">{{ failed ? scene.fallbackLabel : '走进这一幕' }} <span aria-hidden="true">↗</span></span></div>
      </RouterLink>
      </RuntimeImage>
    </div>
  </section>
</template>
<script setup lang="ts">
import { onMounted, onScopeDispose, ref, watch } from 'vue'
import RuntimeImage from '@/components/visual/RuntimeImage.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import SensitivePreviewVeil from '@/components/visual/SensitivePreviewVeil.vue'
import CardEdgeLight from '@/components/visual/CardEdgeLight.vue'
import { useListTransition } from '@/composables/useListTransition'
import type { HomeJournalEntry } from '@/composables/useHomeSceneHighlights'
const props = defineProps<{ scenes: HomeJournalEntry[]; loading?: boolean; error?: string; canRefresh?: boolean }>()
const emit = defineEmits<{ refresh: [] }>()
const section = ref<HTMLElement | null>(null), imagesReady = ref(false)
const listRoot = ref<HTMLElement | null>(null)
useListTransition(listRoot, () => props.scenes.slice(0, 3).map(scene => scene.id))
let observer: IntersectionObserver | undefined
function activateImages() { imagesReady.value = true; observer?.disconnect() }
onMounted(() => {
  if (!('IntersectionObserver' in window)) { activateImages(); return }
  // Keep the original sample quality, but do not let native lazy loading fetch
  // three large samples several screens ahead of the journal itself.
  observer = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) activateImages()
  }, { rootMargin: '300px' })
  if (section.value) observer.observe(section.value)
})
watch(section, (next, previous) => {
  if (previous) observer?.unobserve(previous)
  if (next && !imagesReady.value) observer?.observe(next)
})
onScopeDispose(() => observer?.disconnect())
function excerpt(story?: string) { return (story || '一些想留下的光影，一段只属于角色的时光。').replace(/^【[^】]+】/, '').slice(0, 84) }
</script>
<style scoped>
@reference "../../assets/css/tailwind.css";
.art-journal { margin-block: var(--s-7); }
.journal-heading { align-items: end; }
.journal-heading h2 { font: 500 var(--fs-title-sm)/var(--lh-label) var(--font-serif); margin:var(--s-2) 0 0; }
.journal-heading .eyebrow { @apply tw:text-label-xs; letter-spacing: .16em; @apply tw:text-muted; }
.journal-more { @apply tw:inline-flex tw:items-center tw:gap-s-2 tw:min-h-[44px] tw:text-label tw:text-secondary tw:whitespace-nowrap; }
.journal-actions { @apply tw:flex tw:flex-wrap tw:items-center tw:gap-x-s-5; }
.journal-refresh { border: 0; padding: 0; background: transparent; font-family: inherit; cursor: pointer; min-width: 7em; }
.journal-refresh[aria-disabled="true"] { color: var(--text-disabled); cursor: wait; }
.journal-error { color: var(--text-secondary); font-size: var(--fs-label); margin: 0 0 var(--s-4); }
.journal-spread { grid-template-columns: 1.2fr 1fr; gap: var(--s-5); }
.journal-entry { --card-focus-lift:-8px; --card-focus-scale:1.06; @apply tw:grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); @apply tw:items-center tw:gap-s-5 tw:text-primary tw:min-w-0; }
.journal-entry.lead { grid-row: span 2; @apply tw:flex tw:flex-col tw:items-stretch; }
.journal-art { background: var(--bg-surface); aspect-ratio: 4 / 5; --sensitive-preview-position: center 32%; transition:transform var(--motion-route) var(--spring-soft); }
.journal-missing > span { @apply tw:text-label tw:text-muted; }
.lead .journal-art { aspect-ratio: 4 / 3; }
.journal-art > img { @apply tw:w-full tw:h-full tw:object-cover; object-position: center 32%; transition:transform var(--motion-art-hover) var(--spring-soft); }
.journal-entry:not([data-sensitive='true']) .journal-art::after { content:''; position:absolute; inset:0; pointer-events:none; background:radial-gradient(circle at 50% 50%,color-mix(in srgb,var(--on-art-primary) 18%,transparent),transparent 35%); opacity:0; transition:opacity var(--motion-route) var(--ease-out); }
.journal-entry:focus-visible .journal-art,.journal-entry:focus-visible .journal-art > img { transform:none; transition:none; }
.journal-entry:hover :deep(.sensitive-preview-veil), .journal-entry:focus-within :deep(.sensitive-preview-veil) { opacity:0; }
.journal-caption h3 { margin-block: var(--s-2); font: 500 var(--fs-title-sm)/var(--lh-label) var(--font-serif); }
.lead h3 { @apply tw:text-title; }
.journal-caption p { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; @apply tw:overflow-hidden tw:text-label tw:leading-body tw:text-secondary; }
.journal-entry:focus-visible, .journal-more:focus-visible { outline:none; box-shadow:var(--focus-shadow); border-radius:var(--r-md); }
@media (hover: hover) and (pointer: fine) {
  .journal-entry:hover:not(:focus-visible) .journal-art { transform:translateY(var(--card-focus-lift)); }
  .journal-entry:hover:not(:focus-visible):not([data-sensitive='true']) .journal-art > img { transform:scale(var(--card-focus-scale)); }
  .journal-entry:hover .journal-art::after { opacity:1; }
  .journal-entry:hover .journal-read { text-decoration:underline; text-underline-offset:.25em; }
}
@media (prefers-reduced-motion:reduce) {
  :root:not([data-motion='full']) .journal-entry { --card-focus-lift:0px; --card-focus-scale:1; }
  :root:not([data-motion='full']) :is(.journal-art,.journal-art > img,.journal-art::after) { transition:none; }
}
:root:is([data-motion='reduce'],[data-motion='reduced']) .journal-entry { --card-focus-lift:0px; --card-focus-scale:1; }
:root:is([data-motion='reduce'],[data-motion='reduced']) :is(.journal-art,.journal-art > img,.journal-art::after) { transition:none; }
@media (max-width: 900px) { .journal-spread { @apply tw:gap-s-5; } .journal-entry { grid-template-columns: minmax(0, 1fr); @apply tw:gap-s-3; } .journal-caption p { -webkit-line-clamp: 2; } }
@media (max-width: 600px) { .art-journal { margin-block: var(--s-7); } .journal-heading { align-items: start; @apply tw:flex-col tw:gap-s-3; } .journal-spread { grid-template-columns: minmax(0, 1fr); } .journal-entry:not(.lead) { grid-template-columns: 112px minmax(0, 1fr); @apply tw:pt-s-5; border-top: 1px solid var(--border-soft); } }
</style>
