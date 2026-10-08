<template>
        <ArtistStylePicker
          v-if="pb.directorMode === 'pro'"
          :selected="pb.artistStyleIds"
          :engine="drawEngine"
          :curated-artist-styles="pb.currentCuratedArtistStyles"
          @update:selected="selectArtists"
          @limit-reached="onArtistLimitReached"
        />
        <button v-else class="btn btn-ghost btn-sm" type="button" @click="pb.directorMode = 'pro'">进入专家模式选择画师</button>
</template>

<script setup lang="ts">
import { defineAsyncComponent } from 'vue'
import type { PromptStyleBindings } from '@/composables/prompt/promptPanelBindings'
const ArtistStylePicker = defineAsyncComponent(() => import('@/components/ArtistStylePicker.vue'))

const props = defineProps<{ bindings: PromptStyleBindings }>()
const { pb, drawEngine, onArtistLimitReached } = props.bindings
function selectArtists(ids: string[]) {
  pb.setArtistStyleIds(ids)
}
</script>
