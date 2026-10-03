<template>
        <ArtistStylePicker
          :selected="pb.artistStyleIds"
          :engine="drawEngine"
          :curated-artist-styles="pb.currentCuratedArtistStyles"
          @update:selected="selectArtists"
          @limit-reached="onArtistLimitReached"
        />
        <p v-if="pb.directorMode !== 'pro'" class="manual-artist-hint">选择手动画师会进入专家模式</p>
</template>

<script setup lang="ts">
import { defineAsyncComponent } from 'vue'
import type { PromptStyleBindings } from '@/composables/prompt/promptPanelBindings'
const ArtistStylePicker = defineAsyncComponent(() => import('@/components/ArtistStylePicker.vue'))

const props = defineProps<{ bindings: PromptStyleBindings }>()
const { pb, drawEngine, onArtistLimitReached } = props.bindings
function selectArtists(ids: string[]) {
  pb.setArtistStyleIds(ids)
  if (pb.artistStyleIds.length) pb.directorMode = 'pro'
}
</script>

<style scoped>
.manual-artist-hint { margin:0; color:var(--text-secondary); font-size:var(--fs-label-xs); line-height:var(--lh-body); }
</style>
