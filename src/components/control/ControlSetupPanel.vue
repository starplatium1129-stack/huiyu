<template>
  <div class="control-panel-stack">
    <div class="panel-card">
      <AsyncPanel :loader="loadLocalSetup" label="模型下载与自动配置" v-slot="{ component }"><component :is="component" :blocked="nativeBusy" :settings-revision="nativeRevision" @busy="localBusy = $event" @configured="localRevision++" @ready="localReady = true" /></AsyncPanel>
    </div>
    <details ref="nativeDetails" class="panel-card control-native-options" :open="nativeOpen" @toggle="toggleNative">
      <StudioDisclosureSummary>
        <span>其他绘图方式 · 原生引擎<small>不使用 ComfyUI；在这里检查设备要求、下载原生模型或添加辅助模型。</small></span>
      </StudioDisclosureSummary>
      <div v-if="nativeVisited" data-disclosure-content>
        <InferenceSettingsPanel :blocked="localBusy" :settings-revision="localRevision" @busy="nativeBusy = $event" @configured="nativeRevision++" @ready="nativeReady = true" />
      </div>
    </details>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import AsyncPanel from '@/components/ui/AsyncPanel.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import InferenceSettingsPanel from '@/components/InferenceSettingsPanel.vue'
import { isInferenceSetupOperation } from '@/api/inferenceSetupApi'
import { useControlContext } from '@/composables/useControlContext'
const route = useRoute()
const { status } = useControlContext()
const loadLocalSetup = () => import('@/components/LocalSetupPanel.vue')
const nativeDetails = ref<HTMLDetailsElement | null>(null)
const nativeOpen = ref(false), nativeVisited = ref(false)
const nativeBusy = ref(false), localBusy = ref(false)
const nativeRevision = ref(0), localRevision = ref(0)
const nativeReady = ref(false), localReady = ref(false)
const nativeLink = computed(() => ['#control-inference', '#control-image-resources'].includes(route.hash)
  || ['', '#control-setup'].includes(route.hash) && (route.query.resource || route.query.engine === 'native'
    || ['anima', 'krea2'].includes(String(route.query.engine)) && status.imageProvider.value === 'native'
    || /^(anima-miaomiao-v1\.6|anima-miaomiao-realskin-2\.9b-v1\.0|anima-base-v1\.0|krea2|qwen-image|moss-miaomiao)/.test(String(route.query.model ?? ''))))
function openNative() { nativeVisited.value = true; nativeOpen.value = true }
function toggleNative(event: Event) {
  nativeOpen.value = (event.target as HTMLDetailsElement).open
  if (nativeOpen.value) nativeVisited.value = true
}
watch([() => route.fullPath, nativeLink, localReady, nativeReady], async () => {
  if (route.path !== '/control' || !nativeLink.value) return
  openNative()
  if (!localReady.value || !nativeReady.value) return
  const location = route.fullPath
  await nextTick()
  // Explicit native links land on their owner; background recovery never scrolls.
  if (location !== route.fullPath || !nativeDetails.value?.getClientRects().length) return
  const resource = route.query.resource || route.hash === '#control-image-resources'
    ? document.getElementById('control-image-resources') : null
  const target = resource?.getClientRects().length ? resource : nativeDetails.value
  target.scrollIntoView({ block: 'start', behavior: 'instant' })
}, { immediate: true })
watch(status.operation, operation => {
  if (isInferenceSetupOperation(operation) && operation.status === 'running') openNative()
}, { immediate: true })
</script>

<style scoped>
.control-native-options > summary small { display:block; margin-top:var(--s-1); color:var(--text-secondary); font-size:var(--fs-label-sm); font-weight:400; line-height:var(--lh-body); }
.control-native-options { scroll-margin-top:var(--s-6); }
.control-native-options :deep(.inference-settings) { padding:0; border:0; box-shadow:none; }
@media(max-width:1000px) { .control-native-options { scroll-margin-top:100px; } }
</style>
