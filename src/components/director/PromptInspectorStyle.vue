<template>
  <div ref="host" class="inspector-artist-entry" :class="{ 'is-pro': pb.directorMode === 'pro' }" role="region" aria-label="画师风格" tabindex="-1">
    <AsyncPanel v-if="pb.directorMode === 'pro'" :loader="loadArtistStyles" label="画师风格" v-slot="{ component }">
        <component :is="component"
          :selected="pb.artistStyleIds"
          :engine="drawEngine"
          :curated-artist-styles="pb.currentCuratedArtistStyles"
          @update:selected="selectArtists"
          @limit-reached="onArtistLimitReached"
        />
    </AsyncPanel>
    <button v-else class="btn btn-ghost btn-sm" type="button" @click="enterExpert">进入专家模式选择画师</button>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import AsyncPanel from '@/components/ui/AsyncPanel.vue'
import type { PromptStyleBindings } from '@/composables/prompt/promptPanelBindings'
const loadArtistStyles = () => import('@/components/ArtistStylePicker.vue')
const host = ref<HTMLElement | null>(null)

const props = defineProps<{ bindings: PromptStyleBindings }>()
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
.inspector-artist-entry.is-pro,.inspector-artist-entry :deep(.async-panel-feedback) { min-height:calc(var(--control-height) + var(--s-3)); }
.inspector-artist-entry :deep(.async-panel-feedback) { padding:var(--s-2); }
.inspector-artist-entry :deep(.studio-orbit-spinner) { width:24px; height:24px; }
.inspector-artist-entry:focus-visible { outline:none; border-radius:var(--r-md); box-shadow:var(--focus-shadow); }
@media (forced-colors:active) { .inspector-artist-entry:focus-visible { outline:2px solid Highlight; box-shadow:none; } }
</style>
