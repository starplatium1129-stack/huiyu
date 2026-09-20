<template>
<div class="result-frame inspector-delivery">
          <!-- 出图自动入册偏好（2026-08-31 用户偏好：默认关；开则直出成片自动进作品册，
               批量/队列不受此开关影响，它们按收集语义始终入册） -->
          <div class="auto-save-gallery-row" role="group" aria-label="出图自动入册">
            <ToggleSwitch v-model="autoSaveToGallery" label="出图自动存入作品册" />
            <span class="auto-save-gallery-label">出图自动存入作品册</span>
            <span class="auto-save-gallery-hint">{{ autoSaveToGallery ? '画面生成后自动存入作品册' : '生成后，点「存入作品册」保存喜欢的画面' }}</span>
          </div>

          <!-- 批量出图入口（多场景 / 多角色） -->
          <div class="batch-entry-row">
            <button
              class="btn btn-ghost"
              type="button"
              :disabled="generationBusy"
              :title="generationBusy ? BUSY_HINT : (batchRunning ? '查看本批出图进度' : '批量选择场景或角色，生成后预览成片并自动入册')"
              @click="batchOpen = true"
            >{{ batchRunning ? '查看批量进度' : '批量出图 · 场景 / 多角色' }}</button>
            <span v-if="shotsPending" class="batch-entry-count">
              分镜待带入 {{ shotsPending }} 镜 · <button class="linklike" type="button" @click="goToShots">去分镜短片</button>
            </span>
          </div>

          <!-- 进度统一由画布舞台的 is-generating 态承担（魔法阵 + 进度环，
               2026-08-28 审计后舞台在生成期间保持可见，不再在此重复进度条） -->

          <SDRecoveryPanel :report="sdErrorReport" @recover="runRecovery" @dismiss="dismissError" />
          <GenerationQueuePanel v-if="drawEngine === 'sd'"
            :total="sdQueue.total.value"
            :done="sdQueue.done.value"
            :paused="sdQueue.paused.value"
            :active-job="sdQueue.activeJob.value"
            :queue="sdQueue.queue.value"
            :progress="generationProgress"
            :paused-reason="queuePausedReason"
            @pause="sdQueue.pause"
            @resume="sdQueue.resume"
            @clear="sdQueue.clear"
            @remove="sdQueue.remove"
          />

          <details class="inspector-voice">
          <summary>配音与字幕</summary>
          <VoiceStudio
            ref="voiceStudioRef"
            :initial-voice="pb.char === 'natsume' ? 'natsume' : 'nene'"
            :suggested-caption="pb.activeScene?.story || pb.story"
          />
          </details>

          <DeferredPanel :active="batchOpen">
          <BatchSceneDrawPanel
            :open="batchOpen"
            :scenes="scenes"
            :sd-available="sdOnline"
            :anima-available="animaOnline"
            :deps="batchPanelDeps"
            @close="batchOpen = false"
            @running-change="batchRunning = $event"
          />
          </DeferredPanel>

          </div>
</template>

<script setup lang="ts">
import { defineAsyncComponent } from 'vue'
import type { PromptDeliveryBindings } from '@/composables/prompt/promptPanelBindings'
import ToggleSwitch from '@/components/visual/ToggleSwitch.vue'
const SDRecoveryPanel = defineAsyncComponent(() => import('@/components/SDRecoveryPanel.vue'))
const GenerationQueuePanel = defineAsyncComponent(() => import('@/components/GenerationQueuePanel.vue'))
const VoiceStudio = defineAsyncComponent(() => import('@/components/VoiceStudio.vue'))
import DeferredPanel from '@/components/director/DeferredPanel.vue'
const BatchSceneDrawPanel = defineAsyncComponent(() => import('@/components/BatchSceneDrawPanel.vue'))

const props = defineProps<{ bindings: PromptDeliveryBindings }>()
const { voiceStudioRef, pb, sdOnline, generationBusy, generationProgress, animaOnline, drawEngine, shotsPending, goToShots, sdQueue, BUSY_HINT, autoSaveToGallery, batchRunning, batchOpen, sdErrorReport, runRecovery, dismissError, queuePausedReason, scenes, batchPanelDeps } = props.bindings
</script>

<style src="@/assets/css/director/components/PromptInspectorDelivery.css"></style>
