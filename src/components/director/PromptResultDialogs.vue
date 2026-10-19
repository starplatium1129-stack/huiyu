<template>
  <DeferredDialogHost v-if="compareOpen && prevResult && lastResult && !comparePanel"
    :loader="loadComparePanel" title="出图对比" icon="compare" @ready="comparePanel = $event" @close="closeCompare" />
  <Teleport to="body">
    <FluidTransition>
      <component :is="comparePanel" v-if="comparePanel && compareOpen && prevResult && lastResult"
        :open="compareOpen" :previous="prevResult" :current="lastResult" @close="closeCompare" />
    </FluidTransition>
  </Teleport>
  <Teleport to="body">
    <FluidTransition>
      <div v-show="inpaintOpen" class="modal-backdrop" @click.self="closeInpaint">
        <section ref="inpaintDialog" class="modal-card inpaint-modal" role="dialog" aria-modal="true" :aria-label="inpaintTitle">
          <header class="modal-header">
            <div class="header-title"><h2><ArchiveIcon name="wardrobe" /><span>{{ inpaintTitle }}</span></h2></div>
            <button ref="closeButton" class="btn btn-quiet btn-icon" type="button" aria-label="关闭" @click="closeInpaint"><ArchiveIcon name="close" /></button>
          </header>
          <component :is="inpaintPanel" v-if="inpaintPanel"
            :open="inpaintOpen" :provider="inpaintProvider"
            :automatic-mask-available="inpaintAutomaticMaskAvailable" :automatic-mask-status="inpaintAutomaticMaskStatus"
            :managed-start-available="inpaintManagedStartAvailable" :image-source="inpaintImageSource"
            :current-negative="negativePrompt" :character="inpaintCharacter" :seed="displayResultSeed"
            :submitting="generationBusy" :preparing="inpaintPreparing"
            @whole-image="wholeImage = $event" @close="closeInpaint" @submit="handleInpaintSubmit" />
          <div v-else class="inpaint-panel-feedback" :role="panelFailed ? 'alert' : 'status'" :aria-busy="panelLoading">
            <ArchiveIcon :name="panelFailed ? 'warning' : 'wardrobe'" />
            <p>{{ panelFailed ? '换装画室未能打开，请重试。' : '正在打开换装画室…' }}</p>
            <button v-if="panelFailed" class="btn btn-ghost" type="button" @click="retryPanel">重新打开</button>
          </div>
        </section>
      </div>
    </FluidTransition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, ref, shallowRef, watch, type Component } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import FluidTransition from '@/components/visual/FluidTransition.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { useFocusTrap } from '@/composables/useFocusTrap'
import type { PromptDialogBindings } from '@/composables/prompt/promptPanelBindings'
import DeferredDialogHost from './DeferredDialogHost.vue'
const props = defineProps<{ bindings: PromptDialogBindings }>()
const { inpaintManagedStartAvailable, inpaintProvider, inpaintAutomaticMaskAvailable, inpaintAutomaticMaskStatus, generationBusy, inpaintPreparing, inpaintImageSource, prevResult, inpaintOpen, compareOpen, displayResultSeed, lastResult, closeCompare, negativePrompt, inpaintCharacter, handleInpaintSubmit } = props.bindings
const inpaintDialog = ref<HTMLElement | null>(null), closeButton = ref<HTMLButtonElement | null>(null)
const inpaintPanel = shallowRef<typeof import('@/components/AnimaInpaintModal.vue').default | null>(null)
const comparePanel = shallowRef<Component | null>(null)
const loadComparePanel = () => import('./PromptComparePanel.vue')
const panelLoading = ref(false), panelFailed = ref(false), wholeImage = ref(false)
const inpaintTitle = computed(() => wholeImage.value ? '整图重绘' : inpaintProvider.value === 'native' ? '局部重绘（实验性）' : '智能局部换装')
let attached = true, panelRequest = 0
function closeInpaint() { inpaintOpen.value = false }
useFocusTrap(inpaintDialog, () => inpaintOpen.value, { onEscape: closeInpaint, initialFocus: closeButton })
async function loadPanel() {
  if (!attached || !inpaintOpen.value || inpaintPanel.value) return
  const request = ++panelRequest
  panelLoading.value = true; panelFailed.value = false
  const current = () => attached && inpaintOpen.value && request === panelRequest
  try {
    const module = await import('@/components/AnimaInpaintModal.vue')
    if (current()) inpaintPanel.value = module.default
  } catch {
    if (current()) panelFailed.value = true
  } finally {
    if (current()) panelLoading.value = false
  }
}
function retryPanel() { closeButton.value?.focus({ preventScroll: true }); void loadPanel() }
watch(inpaintOpen, open => {
  if (open) void loadPanel()
  else { panelRequest++; panelLoading.value = false }
}, { immediate: true, flush: 'sync' })
onActivated(() => { attached = true })
onBeforeRouteLeave(() => { panelRequest++; closeInpaint() })
onDeactivated(() => { attached = false; panelRequest++; closeInpaint() })
onBeforeUnmount(() => { attached = false; panelRequest++ })
</script>

<style scoped>
.modal-backdrop { position:fixed; inset:var(--desktop-chrome-height,0px) 0 0; z-index:var(--z-overlay); display:flex; align-items:center; justify-content:center; padding:var(--s-4); background:var(--art-scrim); }
.modal-card.inpaint-modal { position:relative; display:flex; flex-direction:column; width:100%; max-width:1200px; height:min(860px,calc(100dvh - var(--desktop-chrome-height,0px) - 2 * var(--s-4))); min-width:0; padding:0; overflow:hidden; border:1px solid var(--border-soft); border-radius:var(--r-xl); background:var(--bg-surface); color:var(--text-primary); box-shadow:var(--shadow-lg); container:inpaint-dialog / inline-size; }
.modal-header { display:flex; flex-shrink:0; align-items:center; justify-content:space-between; gap:var(--s-3); padding:var(--s-4) var(--s-6); border-bottom:1px solid var(--border-soft); }
.header-title { min-width:0; }
.header-title h2 { display:flex; align-items:center; gap:var(--s-2); margin:0; color:var(--text-primary); font:600 var(--fs-title)/var(--lh-tight) var(--font-sans); overflow-wrap:anywhere; }
.header-title h2 > .archive-icon { width:20px; height:20px; flex:none; }
.modal-header > .btn { flex-shrink:0; }
.inpaint-panel-feedback { display:flex; flex:1; flex-direction:column; align-items:center; justify-content:center; gap:var(--s-3); min-height:0; padding:var(--s-6); overflow:auto; color:var(--text-secondary); text-align:center; }
.inpaint-panel-feedback > .archive-icon { width:32px; height:32px; flex:none; color:var(--accent); }
.inpaint-panel-feedback p { margin:0; overflow-wrap:anywhere; }
@media (max-width:768px) { .modal-header { padding-inline:var(--s-4); } }
</style>
