<template>
  <section v-if="remote || models.length" class="available-models" :aria-labelledby="titleId" :aria-busy="loading">
    <h3 :id="titleId">{{ remote ? '远程绘图模型' : provider === 'comfy' ? 'ComfyUI 可用的绘图模型' : '本机可用的绘图模型' }}</h3>
    <p role="status">{{ message }}</p>
    <div v-if="models.length" class="available-model-field">
      <label :for="modelFieldId">绘图模型</label>
      <StudioSelect :id="modelFieldId" v-model="modelId" label="绘图模型" :options="models" :disabled="loading" />
    </div>
    <div class="available-model-actions">
      <RouterLink v-if="selected && !loading" class="btn btn-primary" :to="firstDrawingRoute(selected.value, selected.family)">去画室生成第一张图</RouterLink>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="loading" @click="refresh">{{ remote ? '重新检查远端' : '重新检查模型' }}</button>
      <button v-if="remote" class="btn btn-quiet btn-sm" type="button" @click="emit('local')">准备本机模型</button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, shallowRef, useId } from 'vue'
import { useRoute } from 'vue-router'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import { apiClient } from '@/api/client'
import { mossStatus } from '@/api/mossApi'
import { qwenStatus } from '@/api/qwenApi'
import { mossModels, qwenModels } from '@/config/directImageModels'
import type { AnimaStatusResponse } from '@/composables/generation/animaSessionContract'
import { firstDrawingRoute, type SetupDrawingFamily } from '@/utils/setupDrawingRoute'

interface ReadyModel { value: string; label: string; family: SetupDrawingFamily }
const props = defineProps<{ provider: 'native' | 'remote' | 'comfy' }>()
const remote = computed(() => props.provider === 'remote')
const titleId = useId(), modelFieldId = useId()
const emit = defineEmits<{ local: [] }>()
const route = useRoute()
const models = shallowRef<ReadyModel[]>([])
const modelId = ref(''), loading = ref(true), message = ref('')
const selected = computed(() => models.value.find(model => model.value === modelId.value))
let controller: AbortController | null = null

async function refresh() {
  if (controller) return
  controller = new AbortController()
  const { signal } = controller
  loading.value = true
  message.value = remote.value ? '正在检查远端模型…' : '正在检查本机模型…'
  const [creative, qwen, moss] = await Promise.allSettled([
    apiClient.request<AnimaStatusResponse>('/api/creative/status', { signal, timeoutMs: 10_000, cachePolicy: 'bypass',
      validate: value => value.ok === true && value.provider === (props.provider === 'comfy' ? 'comfy' : 'native')
        && value.online === true && Array.isArray(value.models) }),
    props.provider === 'comfy' ? [] : qwenStatus(signal),
    props.provider === 'comfy' ? [] : mossStatus(signal),
  ])
  if (signal.aborted) return
  controller = null
  const ready: ReadyModel[] = []
  if (creative.status === 'fulfilled') {
    for (const model of creative.value.models ?? []) {
      if (model?.available === true && typeof model.id === 'string' && model.id
        && (model.family === 'anima' || model.family === 'krea2')) {
        ready.push({ value: model.id, label: model.label || model.id, family: model.family })
      }
    }
  }
  if (qwen.status === 'fulfilled') {
    for (const model of qwenModels) if (qwen.value.some(status => status.id === model.value && status.available)) ready.push({ ...model, family: 'qwen-image' })
  }
  if (moss.status === 'fulfilled') {
    for (const model of mossModels) if (moss.value.some(status => status.id === model.value && status.available)) ready.push({ value: model.value, label: model.label, family: 'moss-image' })
  }
  models.value = ready
  const requested = route.query.model
  modelId.value = [modelId.value, typeof requested === 'string' ? requested : '', 'anima-miaomiao-v1.6']
    .find(id => ready.some(model => model.value === id)) ?? ready[0]?.value ?? ''
  const failures = [creative, qwen, moss].filter(result => result.status === 'rejected').length
  message.value = ready.length
    ? failures ? '已找到可用模型。部分模型清单暂未读取。' : '选择一个已经就绪的模型，即可进入画室。'
    : failures === 3 ? '暂未读取到远端状态。请确认远端绘遇在运行、地址和密钥正确，再重新检查。'
      : '远端还没有就绪的绘图模型。请在显卡电脑上的绘遇准备模型，然后重新检查。'
  loading.value = false
}
onMounted(refresh)
onScopeDispose(() => controller?.abort())
</script>

<style scoped>
.available-models { display:grid; gap:var(--s-3); margin-block-start:var(--s-4); padding:var(--s-4); border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--bg-elevated); }
.available-models :is(h3,p) { margin:0; }
.available-models p { color:var(--text-secondary); }
.available-model-field { display:grid; gap:var(--s-2); max-inline-size:28rem; }
.available-model-actions { display:flex; align-items:center; flex-wrap:wrap; gap:var(--s-2); }
</style>
