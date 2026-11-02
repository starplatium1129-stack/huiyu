<template>
  <button class="prompt-workbench-entry" data-control-motion type="button" @click="openWorkbench">
    <span class="prompt-workbench-mark studio-control-icon"><ArchiveIcon name="palette" /></span>
    <span class="prompt-workbench-copy studio-control-label"><strong>词条工作台</strong><small v-if="pb.manualTags.size">已选 {{ pb.manualTags.size }} 个词条</small></span>
    <ArchiveIcon class="prompt-workbench-arrow" name="chevron-down" />
  </button>
  <dialog ref="workbenchDialog" class="prompt-workbench-dialog" :aria-labelledby="headingId"
    @cancel.prevent="motion.close()" @click="onBackdropClick">
    <header class="prompt-reader-heading"><h2 :id="headingId">词条工作台</h2><button class="btn btn-quiet btn-icon" type="button" aria-label="关闭词条工作台" @click="motion.close()"><ArchiveIcon name="close" /></button></header>
    <div class="prompt-workbench-body"><DeferredPanel :active="loaded"><AsyncPanel :loader="loadWorkbench" label="词条工作台" v-slot="{ component }"><component :is="component" :prompt-format="promptFormat" :model-profile="modelProfile" /></AsyncPanel></DeferredPanel></div>
  </dialog>
</template>

<script setup lang="ts">
import { nextTick, ref, useId } from 'vue'
import type { DrawCapabilities, ModelProfile } from '@/utils/promptPolicy'
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import { isBackdropClick, useFluidDialog } from '@/composables/useFluidDialog'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import AsyncPanel from '@/components/ui/AsyncPanel.vue'
import DeferredPanel from './DeferredPanel.vue'
import '@/assets/css/director/components/PromptHealthPanel.css'

defineProps<{ promptFormat: DrawCapabilities['promptFormat'] | 'moss-hybrid'; modelProfile: ModelProfile | null }>()
const pb = usePromptBuilderStore(), headingId = useId()
const loadWorkbench = () => import('./DirectorTagWorkbench.vue')
const workbenchDialog = ref<HTMLDialogElement | null>(null), loaded = ref(false)
const motion = useFluidDialog(workbenchDialog)
async function openWorkbench(event: MouseEvent) {
  const source = event.currentTarget as HTMLElement
  pb.directorMode = 'pro'
  loaded.value = true
  await nextTick()
  if (source.isConnected) motion.open(source)
}
function onBackdropClick(event: MouseEvent) { if (isBackdropClick(event, workbenchDialog.value)) motion.close() }
</script>
