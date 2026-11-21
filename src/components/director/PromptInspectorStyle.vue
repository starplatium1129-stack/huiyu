<template>
  <div ref="host" class="inspector-artist-entry" :class="{ 'is-pro': pb.directorMode === 'pro' }" role="region" aria-label="画师风格" tabindex="-1">
    <AsyncPanel v-if="pb.directorMode === 'pro'" :loader="loadArtistStyles" label="画师风格" v-slot="{ component }">
        <component :is="component"
          :selected="pb.artistStyleIds"
          :engine="engine || drawEngine"
          :curated-artist-styles="pb.currentCuratedArtistStyles"
          @update:selected="selectArtists"
          @limit-reached="onArtistLimitReached"
        />
    </AsyncPanel>
    <button v-else class="inspector-artist-basic-trigger" type="button" data-control-motion @click="enterExpert">
      <span class="inspector-artist-basic-title"><ArchiveIcon name="palette" /><span>画师风格</span></span>
      <span class="inspector-artist-basic-action"><span>{{ pb.artistStyleIds.length ? `已选 ${pb.artistStyleIds.length} 位` : '进入专家模式挑选' }}</span><ArchiveIcon name="chevron-down" /></span>
    </button>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import AsyncPanel from '@/components/ui/AsyncPanel.vue'
import type { PromptStyleBindings } from '@/composables/prompt/promptPanelBindings'
const loadArtistStyles = () => import('@/components/ArtistStylePicker.vue')
const host = ref<HTMLElement | null>(null)

const props = defineProps<{ bindings: PromptStyleBindings; engine?: 'moss' }>()
const { pb, drawEngine, onArtistLimitReached } = props.bindings
function enterExpert(event: MouseEvent) {
  if (document.activeElement === event.currentTarget) host.value?.focus({ preventScroll: true })
  pb.directorMode = 'pro'
}
function selectArtists(ids: string[]) {
  pb.setArtistStyleIds(ids)
}
</script>

<style scoped>
.inspector-artist-entry { min-width:0; }
.inspector-artist-entry.is-pro,.inspector-artist-entry :deep(.async-panel-feedback) { min-height:var(--control-height); }
.inspector-artist-entry :deep(.async-panel-feedback) { padding:var(--s-2); }
.inspector-artist-entry :deep(.studio-orbit-spinner) { width:24px; height:24px; }
.inspector-artist-basic-trigger { display:flex; align-items:center; justify-content:space-between; gap:var(--s-2); width:100%; min-height:var(--control-height); padding:var(--s-2) 0; border:0; border-radius:var(--r-md); background:transparent; color:var(--text-primary); font:600 var(--fs-label)/var(--lh-label) var(--font-sans); cursor:pointer; }
.inspector-artist-basic-title { display:inline-flex; align-items:center; gap:var(--s-2); }
.inspector-artist-basic-title .archive-icon { width:16px; height:16px; color:var(--accent); }
.inspector-artist-basic-action { display:inline-flex; align-items:center; gap:var(--s-1); color:var(--text-secondary); font-weight:400; }
.inspector-artist-basic-action .archive-icon { width:15px; height:15px; transform:rotate(-90deg); }
.inspector-artist-basic-trigger:focus-visible,.inspector-artist-entry:focus-visible { outline:none; border-radius:var(--r-md); box-shadow:var(--focus-shadow); }
@media (hover:hover) and (pointer:fine) { .inspector-artist-basic-trigger:hover { color:var(--accent); } }
@media (forced-colors:active) { .inspector-artist-basic-trigger:focus-visible,.inspector-artist-entry:focus-visible { outline:2px solid Highlight; box-shadow:none; } }
</style>
