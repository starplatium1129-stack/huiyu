<template>
<DeferredPanel :active="pb.directorMode === 'pro'"><DirectorTagWorkbench /></DeferredPanel>

        <PromptHealthPanel
          class="advanced-decision basic-visible"
          :prompt="previewPromptView"
          :model-name="modelProfileView?.name"
          :report="reportView"
          :art-violations="artViolationsView"
          :lora-text="pb.isPopular ? '' : loraSpecs.map(s => s.name + ':' + s.weight).join(' · ')"
          :open="pb.directorMode === 'pro'"
          :compact="pb.directorMode === 'basic'"
          @copy="copyPrompt"
          @save="saveCurrentResult"
        />
</template>

<script setup lang="ts">
import { defineAsyncComponent } from 'vue'
import type { PromptHealthBindings } from '@/composables/prompt/promptPanelBindings'
import DeferredPanel from '@/components/director/DeferredPanel.vue'
const DirectorTagWorkbench = defineAsyncComponent(() => import('@/components/director/DirectorTagWorkbench.vue'))
const PromptHealthPanel = defineAsyncComponent(() => import('@/components/PromptHealthPanel.vue'))

const props = defineProps<{ bindings: PromptHealthBindings }>()
const { pb, previewPromptView, modelProfileView, reportView, artViolationsView, loraSpecs, copyPrompt, saveCurrentResult } = props.bindings
</script>
