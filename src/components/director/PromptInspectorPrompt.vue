<template>
  <button class="prompt-workbench-entry" data-control-motion type="button" @click="openWorkbench">
    <span class="prompt-workbench-mark studio-control-icon"><ArchiveIcon name="palette" /></span>
    <span class="prompt-workbench-copy studio-control-label"><strong>词条工作台</strong><small>{{ pb.directorMode === 'pro' ? (pb.manualTags.size ? '已选 ' + pb.manualTags.size + ' 个词条 · 搜索与编辑' : '搜索词条 · 服装预设 · 批量添加') : '进入专家模式，搜索与编辑词条' }}</small></span>
    <ArchiveIcon class="prompt-workbench-arrow" name="chevron-down" />
  </button>
  <PromptHealthPanel class="advanced-decision basic-visible"
    :prompt="previewPromptView" :context="previewContext" :model-name="modelProfileView?.name"
    :report="reportView" :art-violations="artViolationsView"
    :lora-text="pb.isPopular ? '' : loraSpecs.map(s => s.name + ':' + s.weight).join(' · ')"
    :copy-action="copyPrompt" @save="saveDraft" />
  <dialog ref="workbenchDialog" class="prompt-workbench-dialog" aria-labelledby="prompt-workbench-heading"
    @cancel.prevent="workbenchMotion.close()" @click="onWorkbenchClick">
    <header class="prompt-reader-heading"><h2 id="prompt-workbench-heading">词条工作台</h2><button class="btn btn-quiet btn-icon" type="button" aria-label="关闭词条工作台" @click="workbenchMotion.close()"><ArchiveIcon name="close" /></button></header>
    <div class="prompt-workbench-body"><DeferredPanel :active="workbenchLoaded"><AsyncPanel :loader="loadTagWorkbench" label="词条工作台" v-slot="{ component }"><component :is="component" :prompt-format="previewContext.format" :model-profile="modelProfileView" /></AsyncPanel></DeferredPanel></div>
  </dialog>
</template>

<script setup lang="ts">
import { nextTick, ref } from 'vue'
import type { PromptHealthBindings } from '@/composables/prompt/promptPanelBindings'
import DeferredPanel from '@/components/director/DeferredPanel.vue'
import AsyncPanel from '@/components/ui/AsyncPanel.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { isBackdropClick, useFluidDialog } from '@/composables/useFluidDialog'
import '@/assets/css/director/components/PromptHealthPanel.css'
const loadTagWorkbench = () => import('@/components/director/DirectorTagWorkbench.vue')
import PromptHealthPanel from '@/components/PromptHealthPanel.vue'

const props = defineProps<{ bindings: PromptHealthBindings }>()
const { pb, previewPromptView, previewContext, modelProfileView, reportView, artViolationsView, loraSpecs, copyPrompt, saveDraft } = props.bindings
const workbenchDialog = ref<HTMLDialogElement | null>(null)
const workbenchMotion = useFluidDialog(workbenchDialog)
const workbenchLoaded = ref(false)
async function openWorkbench(event: MouseEvent) {
  const source = event.currentTarget as HTMLElement
  pb.directorMode = 'pro'
  workbenchLoaded.value = true
  await nextTick()
  workbenchMotion.open(source)
}
function onWorkbenchClick(event: MouseEvent) { if (isBackdropClick(event, workbenchDialog.value)) workbenchMotion.close() }
</script>
