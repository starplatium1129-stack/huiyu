<template>
  <div class="control-panel-stack">
    <div class="setup-engine-switch studio-segments" role="group" aria-label="配置入口">
      <AnimatedSelection />
      <button type="button" :aria-pressed="mode === 'native'" @click="choose('native')">原生绘图</button>
      <button type="button" :aria-pressed="mode === 'comfy'" @click="choose('comfy')">ComfyUI · 本地聊天</button>
    </div>
    <div v-if="localVisited" v-show="mode === 'comfy'" class="panel-card">
      <AsyncPanel :loader="loadLocalSetup" label="绘图与本地聊天" v-slot="{ component }"><component :is="component" :blocked="nativeBusy" :settings-revision="nativeRevision" @busy="localBusy = $event" @configured="localRevision++" /></AsyncPanel>
    </div>
    <div v-if="nativeVisited" v-show="mode === 'native'" ref="nativePanel" class="panel-card control-native-options">
      <InferenceSettingsPanel :blocked="localBusy" :settings-revision="localRevision" @busy="nativeBusy = $event" @configured="nativeRevision++" @ready="nativeReady = true" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import AsyncPanel from '@/components/ui/AsyncPanel.vue'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import InferenceSettingsPanel from '@/components/InferenceSettingsPanel.vue'
import { isInferenceSetupOperation } from '@/api/inferenceSetupApi'
import { useControlContext } from '@/composables/useControlContext'
const route = useRoute()
const { status } = useControlContext()
const loadLocalSetup = () => import('@/components/LocalSetupPanel.vue')
const nativePanel = ref<HTMLElement | null>(null)
const mode = ref<'native' | 'comfy'>(status.imageProvider.value === 'native' ? 'native' : 'comfy')
const nativeVisited = ref(false), localVisited = ref(false), chosen = ref(false)
const nativeBusy = ref(false), localBusy = ref(false)
const nativeRevision = ref(0), localRevision = ref(0)
const nativeReady = ref(false)
const localLink = computed(() => route.hash === '#setup-chat-options' || route.hash === '#control-comfy')
const nativeLink = computed(() => ['#control-inference', '#control-image-resources'].includes(route.hash)
  || ['', '#control-setup'].includes(route.hash) && (route.query.resource || route.query.engine === 'native'
    || ['anima', 'krea2'].includes(String(route.query.engine)) && status.imageProvider.value === 'native'
    || /^(anima-miaomiao-v1\.6|anima-miaomiao-realskin-2\.9b-v1\.0|anima-base-v1\.0|krea2|qwen-image|moss-miaomiao)/.test(String(route.query.model ?? ''))))
function choose(value: 'native' | 'comfy') { chosen.value = true; mode.value = value }
watch(mode, value => { if (value === 'native') nativeVisited.value = true; else localVisited.value = true }, { immediate: true })
watch([() => route.fullPath, status.imageProvider, status.statusLoaded], () => {
  if (nativeLink.value) mode.value = 'native'
  else if (localLink.value) mode.value = 'comfy'
  else if (!chosen.value && status.statusLoaded.value) mode.value = status.imageProvider.value === 'native' ? 'native' : 'comfy'
}, { immediate: true })
watch([() => route.fullPath, nativeLink, nativeReady], async () => {
  if (route.path !== '/control' || !nativeLink.value || !nativeReady.value) return
  const location = route.fullPath
  await nextTick()
  // Explicit native links land on their owner; background recovery never scrolls.
  if (location !== route.fullPath || !nativePanel.value?.getClientRects().length) return
  const resource = route.query.resource || route.hash === '#control-image-resources'
    ? document.getElementById('control-image-resources') : null
  const target = resource?.getClientRects().length ? resource : nativePanel.value
  target.scrollIntoView({ block: 'start', behavior: 'instant' })
}, { immediate: true })
watch(status.operation, operation => {
  if (isInferenceSetupOperation(operation) && operation.status === 'running') mode.value = 'native'
}, { immediate: true })
</script>

<style scoped>
.setup-engine-switch { align-self:start; max-inline-size:100%; flex-wrap:wrap; }
.control-native-options { scroll-margin-top:var(--s-6); }
.control-native-options :deep(.inference-settings) { padding:0; border:0; box-shadow:none; }
@media(max-width:1000px) { .control-native-options { scroll-margin-top:100px; } }
</style>
