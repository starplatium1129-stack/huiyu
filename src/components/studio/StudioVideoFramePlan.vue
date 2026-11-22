<template>
  <div class="studio-video-form">
    <div class="studio-video-fields">
      <div>
        <label for="studio-frameplan-model">补帧模型</label>
        <StudioSelect id="studio-frameplan-model" v-model="plan.modelId" :options="models" :disabled="busy" />
      </div>
      <div>
        <label for="studio-frameplan-canvas">关键帧画幅</label>
        <StudioSelect
          id="studio-frameplan-canvas"
          v-model="plan.canvas"
          :options="canvasOptions"
          :disabled="busy"
        />
      </div>
      <div>
        <label for="studio-frameplan-asset">图片参考</label>
        <StudioSelect
          id="studio-frameplan-asset"
          v-model="picked"
          :options="versions"
          searchable
          placeholder="选择素材版本"
          :disabled="busy || !versions.length || plan.referenceVersionIds.length >= 4"
        />
      </div>
    </div>
    <div class="studio-actions">
      <button
        type="button"
        class="btn btn-ghost btn-sm"
        :disabled="busy || !picked || full || plan.referenceVersionIds.includes(picked)"
        @click="add"
      >
        <ArchiveIcon name="plus" />加入参考
      </button>
      <button
        type="button"
        class="btn btn-ghost btn-sm"
        :disabled="busy || !workbenchReferences().length"
        @click="useWorkbench"
      >
        沿用关键帧工坊参考
      </button>
    </div>
    <ol v-if="plan.referenceVersionIds.length" class="studio-ref-list" aria-label="补帧参考图顺序">
      <li v-for="(id, index) in plan.referenceVersionIds" :key="id">
        <StudioAssetThumb :version="data.versions.find((v) => v.id === id)" />
        <span class="studio-ref-name">{{ index + 1 }}. {{ versionLabel(data, id) }}</span>
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          :disabled="busy || index === 0"
          :aria-label="'上移参考图 ' + (index + 1)"
          @click="move(index, -1)"
        >
          上移
        </button>
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          :disabled="busy || index === plan.referenceVersionIds.length - 1"
          :aria-label="'下移参考图 ' + (index + 1)"
          @click="move(index, 1)"
        >
          下移
        </button>
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          :disabled="busy"
          :aria-label="'移除参考图 ' + (index + 1)"
          @click="plan.referenceVersionIds.splice(index, 1)"
        >
          移除
        </button>
      </li>
    </ol>
    <div v-if="missingFirst">
      <label for="studio-frameplan-first">首帧画面变化</label>
      <textarea
        id="studio-frameplan-first"
        v-model="plan.firstPrompt"
        class="textarea"
        rows="2"
        maxlength="2000"
        :disabled="busy"
        placeholder="例如，角色刚走到窗前。留空时使用各镜头的描述。"
      />
    </div>
    <div v-if="missingLast">
      <label for="studio-frameplan-last">尾帧画面变化</label>
      <textarea
        id="studio-frameplan-last"
        v-model="plan.lastPrompt"
        class="textarea"
        rows="2"
        maxlength="2000"
        :disabled="busy"
        placeholder="例如，角色转身望向镜头。留空时使用各镜头的描述。"
      />
    </div>
    <p v-if="feedback" role="status" class="studio-caption">{{ feedback }}</p>
  </div>
</template>
<script setup lang="ts">
import { computed, ref } from 'vue'
import type { StudioFramePlan } from '@/api/studioVideoApi'
import type { StudioProjectSnapshot } from '@/storage/studioProjectRepository'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioAssetThumb from './StudioAssetThumb.vue'
import { imageVersion, referenceIssue, versionLabel } from './projectAssets'
import { canvases } from './keyframeDraft'
const props = defineProps<{
  data: StudioProjectSnapshot
  busy: boolean
  missingFirst: boolean
  missingLast: boolean
  workbenchReferences: () => string[]
}>()
const plan = defineModel<StudioFramePlan>({ required: true })
const picked = ref(''),
  feedback = ref('')
const models = [
  { value: 'flux-kontext-dev', label: 'FLUX.1 Kontext' },
  { value: 'minimax-h3-image-q4', label: 'MiniMax H3 Image Q4' },
]
const canvasOptions = Object.entries(canvases).map(([value, item]) => ({ value, label: item.label }))
const versions = computed(() => {
  const titles = new Map(props.data.assets.map((asset) => [asset.id, asset.title]))
  return props.data.versions
    .filter((v) => imageVersion(v) && !referenceIssue(v))
    .map((v) => ({ value: v.id, label: (titles.get(v.assetId) || '素材') + ' · v' + v.number }))
})
const full = computed(() => plan.value.referenceVersionIds.length >= 4)
function add() {
  if (
    full.value ||
    !versions.value.some((v) => v.value === picked.value) ||
    plan.value.referenceVersionIds.includes(picked.value)
  )
    return
  plan.value.referenceVersionIds.push(picked.value)
  picked.value = ''
  feedback.value = ''
}
function useWorkbench() {
  const ids = props.workbenchReferences()
  if (ids.length < 1 || ids.length > 4 || ids.some((id) => !versions.value.some((v) => v.value === id))) {
    feedback.value = '请在关键帧工坊选择 1 至 4 张可用的 PNG、JPEG 或 WebP 参考图。'
    return
  }
  plan.value.referenceVersionIds = [...ids]
  feedback.value = '已沿用工坊中的参考顺序。'
}
function move(index: number, direction: number) {
  const refs = plan.value.referenceVersionIds
  const [item] = refs.splice(index, 1)
  if (item) refs.splice(index + direction, 0, item)
  feedback.value = `参考图已移至第 ${index + direction + 1} 位。`
}
</script>
