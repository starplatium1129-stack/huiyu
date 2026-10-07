<template>
        <PromptHealthPanel
          class="advanced-decision basic-visible"
          :prompt="previewPromptView"
          :model-name="modelProfileView?.name"
          :report="reportView"
          :art-violations="artViolationsView"
          :lora-text="pb.isPopular ? '' : loraSpecs.map(s => s.name + ':' + s.weight).join(' · ')"
          :open="true"
          :compact="pb.directorMode === 'basic'"
          @copy="copyPrompt"
          @save="saveCurrentResult"
        />
<details v-show="pb.directorMode === 'pro'" class="inspector-route inspector-tags">
  <summary><span>词条编辑</span><ArchiveIcon name="chevron-down" /></summary>
  <DeferredPanel :active="pb.directorMode === 'pro'"><div data-disclosure-content><DirectorTagWorkbench /></div></DeferredPanel>
</details>
</template>

<script setup lang="ts">
import { defineAsyncComponent } from 'vue'
import type { PromptHealthBindings } from '@/composables/prompt/promptPanelBindings'
import DeferredPanel from '@/components/director/DeferredPanel.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
const DirectorTagWorkbench = defineAsyncComponent(() => import('@/components/director/DirectorTagWorkbench.vue'))
const PromptHealthPanel = defineAsyncComponent(() => import('@/components/PromptHealthPanel.vue'))

const props = defineProps<{ bindings: PromptHealthBindings }>()
const { pb, previewPromptView, modelProfileView, reportView, artViolationsView, loraSpecs, copyPrompt, saveCurrentResult } = props.bindings
</script>
