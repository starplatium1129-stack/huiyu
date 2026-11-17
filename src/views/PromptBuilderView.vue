<script setup lang="ts">
import AsyncPanel from '@/components/ui/AsyncPanel.vue'
import { useDrawingWorkspace } from '@/composables/prompt/useDrawingWorkspace'
import { loadPromptDrawingWorkspace, prefetchDrawingResources } from '@/router/routeFeatures'

// The route shell and primary workspace download in parallel with the catalog.
// PromptDrawingWorkspace reuses these store-owned requests and keeps error UI.
void loadPromptDrawingWorkspace().catch(() => {})
prefetchDrawingResources()
const { editorPanel, editorOpen, editorEntry, sourceImage, opener, closeEditor } = useDrawingWorkspace()
</script>

<template>
  <div class="drawing-workspace">
    <AsyncPanel :loader="loadPromptDrawingWorkspace" label="绘图画室" v-slot="{ component }"><component :is="component" /></AsyncPanel>
    <component v-if="editorOpen && editorPanel" :is="editorPanel" :key="editorEntry" :source-image="sourceImage" :opener="opener" @closed="closeEditor" @source-consumed="sourceImage = null" />
  </div>
</template>

<style scoped>
.drawing-workspace { min-width:0; }
</style>
