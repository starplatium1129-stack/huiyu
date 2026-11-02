<template>
  <PromptTagWorkbench :prompt-format="previewContext.format" :model-profile="modelProfileView" />
  <PromptHealthPanel class="advanced-decision basic-visible"
    :prompt="previewPromptView" :context="previewContext" :model-name="modelProfileView?.name"
    :report="reportView" :art-violations="artViolationsView"
    :lora-text="pb.isPopular ? '' : loraSpecs.map(s => s.name + ':' + s.weight).join(' · ')"
    :copy-action="copyPrompt" @save="saveDraft" />
</template>

<script setup lang="ts">
import type { PromptHealthBindings } from '@/composables/prompt/promptPanelBindings'
import PromptTagWorkbench from './PromptTagWorkbench.vue'
import PromptHealthPanel from '@/components/PromptHealthPanel.vue'

const props = defineProps<{ bindings: PromptHealthBindings }>()
const { pb, previewPromptView, previewContext, modelProfileView, reportView, artViolationsView, loraSpecs, copyPrompt, saveDraft } = props.bindings
</script>
