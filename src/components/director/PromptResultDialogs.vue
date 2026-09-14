<template>
<!-- 出图大图对比：上一张 vs 当前 -->
    <Teleport to="body">
      <FluidTransition>
        <PromptComparePanel v-if="compareOpen && prevResult && lastResult"
          :previous="prevResult" :current="lastResult" @ready="compareEl = $event" @close="closeCompare" />
      </FluidTransition>
    </Teleport>

    <!-- Anima 智能局部换装弹窗 -->
    <Teleport to="body">
      <DeferredPanel :active="inpaintOpen">
      <AnimaInpaintModal
        :open="inpaintOpen"
        :image-url="displayResultUrl"
        :image-blob="resultBlob"
        :current-prompt="livePrompt"
        :current-negative="negativePrompt"
        :character="inpaintCharacter"
        :adult-enabled="adultEnabled"
        :seed="displayResultSeed"
        :submitting="generationBusy"
        @close="inpaintOpen = false"
        @submit="handleInpaintSubmit"
      />
      </DeferredPanel>
    </Teleport>
</template>

<script setup lang="ts">
import FluidTransition from "@/components/visual/FluidTransition.vue"
import { defineAsyncComponent } from 'vue'
import type { PromptDialogBindings } from '@/composables/prompt/promptPanelBindings'
import DeferredPanel from './DeferredPanel.vue'
const PromptComparePanel = defineAsyncComponent(() => import('./PromptComparePanel.vue'))
const AnimaInpaintModal = defineAsyncComponent(() => import('@/components/AnimaInpaintModal.vue'))
const props = defineProps<{ bindings: PromptDialogBindings }>()
const { compareEl, adultEnabled, displayResultUrl, generationBusy, resultBlob, prevResult, inpaintOpen, compareOpen, displayResultSeed, lastResult, closeCompare, livePrompt, negativePrompt, inpaintCharacter, handleInpaintSubmit } = props.bindings
</script>
