<template>
  <section class="studio-panel studio-keyframes" aria-labelledby="studio-keyframe-title">
    <header class="studio-heading">
      <h2 id="studio-keyframe-title">关键帧工坊</h2>
      <span class="studio-caption" role="status">{{ saving ? '正在保存' : '' }}</span>
    </header>
    <p v-if="writeError" class="studio-feedback" role="alert">
      {{ writeError }} <button type="button" class="btn btn-ghost btn-sm" @click="$emit('reload')">重新读取工坊</button>
    </p>
    <KeyframeGuide ref="guideView" :tools="guideTools" :locked="locked || importing" :importing="importing" @import="pickGuidedFile" />
    <input ref="guidePicker" type="file" :accept="imageAccept" hidden @change="pickedGuidedFile" />
    <div v-if="!remaining" class="studio-guide-submit">
      <button class="btn btn-primary" type="button" :disabled="locked || importing || !preferredModel || !!guideIssue" @click="generateGuided">
        <ArchiveIcon name="spark" />{{ guideAction }}
      </button>
      <span v-if="!writeError" class="studio-caption">{{ guideIssue || (plan?.prepare ? '首次生成会先整理干净立绘。' : '') }}</span>
    </div>
    <div v-if="loadingModels || modelError || !preferredModel" class="studio-model-state">
      <span>{{ modelError || (loadingModels ? '正在检测本机绘图能力…' : '本机绘图模型尚未就绪') }}</span>
      <button v-if="!loadingModels" class="btn btn-ghost btn-sm" type="button" @click="loadModels">重新检测</button>
    </div>
    <details ref="advanced" class="studio-keyframe-advanced">
      <StudioDisclosureSummary>高级编辑</StudioDisclosureSummary>
      <div data-disclosure-content>
        <div v-if="character && guide.mode === 'outfit'" class="studio-guide-selection">
          <div>
            <label for="studio-outfit-reference">换装用的服装参考图</label>
            <StudioSelect id="studio-outfit-reference" :model-value="guide.garmentVersionId" :options="garmentOptions"
              :disabled="locked || importing" searchable @update:model-value="guideTools.update({ garmentVersionId: String($event) })" />
          </div>
          <button type="button" class="btn btn-ghost btn-sm" :disabled="locked || importing" @click="pickGuidedFile('outfit')">导入服装参考</button>
        </div>
        <div v-if="character && guide.mode === 'scene'" class="studio-guide-selection">
          <div>
            <label for="studio-face-reference">拍套图用的同角色脸部特写</label>
            <StudioSelect id="studio-face-reference" :model-value="guide.faceVersionId" :options="faceOptions"
              :disabled="locked || importing" searchable @update:model-value="guideTools.update({ faceVersionId: String($event) })" />
          </div>
          <button type="button" class="btn btn-ghost btn-sm" :disabled="locked || importing" @click="pickGuidedFile('expression')">导入脸部特写</button>
        </div>
        <form aria-label="手动编辑候选图" @submit.prevent="generateManual">
          <fieldset :disabled="locked" class="studio-references" @dragover="allowDrop" @drop="drop">
            <legend>参考图 · 按顺序输入模型</legend>
            <ol v-if="draft.form.references.length" class="studio-ref-list">
              <li v-for="(id, i) in draft.form.references" :key="id">
                <StudioAssetThumb :version="byId(id)" />
                <span class="studio-ref-name">{{ i + 1 }}. {{ versionLabel(data, id) }}</span>
                <div class="studio-actions">
                  <button
                    type="button"
                    class="btn btn-ghost btn-sm"
                    data-order="previous"
                    :aria-label="'前移参考图 ' + (i + 1)"
                    :disabled="i === 0"
                    @click="move($event, i, -1)"
                  >
                    前移
                  </button>
                  <button
                    type="button"
                    class="btn btn-ghost btn-sm"
                    data-order="next"
                    :aria-label="'后移参考图 ' + (i + 1)"
                    :disabled="i === draft.form.references.length - 1"
                    @click="move($event, i, 1)"
                  >
                    后移
                  </button>
                  <button
                    type="button"
                    class="btn btn-ghost btn-sm"
                    :aria-label="'移除参考图 ' + (i + 1)"
                    @click="draft.form.references.splice(i, 1)"
                  >
                    移除
                  </button>
                </div>
              </li>
            </ol>
            <p v-else class="studio-caption">把角色和场景从素材库拖到这里，或使用素材上的「用作参考」。</p>
            <input ref="filePicker" type="file" :accept="imageAccept" multiple hidden @change="pickedFiles" />
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              :disabled="importing || draft.form.references.length >= referenceLimit"
              @click="filePicker?.click()"
            >
              从文件添加参考图
            </button>
          </fieldset>
          <div class="studio-field-grid">
            <div>
              <label for="studio-model">本地绘图模型</label
              ><StudioSelect id="studio-model" :model-value="draft.form.modelId" :options="modelOptions" :disabled="locked"
                @update:model-value="setModel(String($event))" />
            </div>
            <div>
              <label for="studio-canvas">画幅</label
              ><StudioSelect id="studio-canvas" v-model="draft.form.canvas" :options="canvasOptions" :disabled="locked || !canvasOptions.length" />
            </div>
            <div v-if="model">
              <label for="studio-keyframe-steps">采样步数</label>
              <input v-if="model.id === fluxModelId" id="studio-keyframe-steps" class="input" type="number" min="1" max="100" step="1"
                :value="draft.form.steps" :placeholder="model.defaultSteps ? String(model.defaultSteps) : '模型默认'"
                :disabled="locked" @input="changeSteps" />
              <input v-else id="studio-keyframe-steps" class="input" :value="model.defaultSteps ?? '模型固定'" readonly :disabled="locked" />
            </div>
          </div>
          <div class="studio-model-state">
            <span role="status">{{
              modelError ||
              (loadingModels
                ? '正在检测本地模型…'
                : model?.available
                  ? '本地模型文件已就绪'
                  : model?.reason || '本地模型尚未就绪')
            }}</span>
            <button class="btn btn-ghost btn-sm" type="button" :disabled="loadingModels" @click="loadModels">
              重新检测
            </button>
          </div>
          <label for="studio-directive">编辑指令</label>
          <textarea
            id="studio-directive"
            v-model="draft.form.prompt"
            class="textarea"
            rows="3"
            maxlength="4000"
            required
            :disabled="locked"
            placeholder="保持参考图 1 的人物外观，让她站在参考图 2 的窗边。"
          />
          <label for="studio-variations">每张候选的变化（选填，每行一张，最多四张）</label>
          <textarea
            id="studio-variations"
            v-model="draft.form.variations"
            class="textarea"
            rows="2"
            maxlength="3500"
            :disabled="locked"
            placeholder="首帧，目光落在窗外。&#10;尾帧，转身看向镜头。"
          />
          <div class="studio-field-grid">
            <div>
              <label for="studio-output-kind">生成内容</label
              ><StudioSelect id="studio-output-kind" v-model="draft.form.kind" :options="outputKinds" :disabled="locked" />
            </div>
            <div>
              <label for="studio-output-title">素材名称</label
              ><input
                id="studio-output-title"
                v-model="draft.form.title"
                class="input"
                maxlength="100"
                :disabled="locked"
                :placeholder="assetLabels[draft.form.kind]"
              />
            </div>
            <div>
              <label for="studio-count">候选张数</label
              ><StudioSelect
                id="studio-count"
                :model-value="variationCount || draft.form.count"
                :options="countOptions"
                :disabled="locked || !!variationCount"
                @update:model-value="draft.form.count = Number($event)"
              />
            </div>
            <div>
              <label for="studio-seed">起始种子</label
              ><input
                id="studio-seed"
                v-model="draft.form.seedText"
                class="input"
                inputmode="numeric"
                maxlength="10"
                placeholder="留空随机"
                :disabled="locked"
              />
            </div>
          </div>
          <div class="studio-actions">
            <button
              v-if="!remaining"
              class="btn btn-primary"
              type="submit"
              :disabled="
                locked || importing || !model?.available || !draft.form.references.length || !draft.form.prompt.trim()
              "
            >
              <ArchiveIcon name="spark" />按高级设置生成
            </button>
          </div>
        </form>
      </div>
    </details>
    <div v-if="remaining" class="studio-actions">
      <button v-if="!busy" class="btn btn-primary" type="button" :disabled="cancelling || !!writeError" @click="run">继续原批次</button>
      <button class="btn btn-ghost" type="button" :disabled="cancelling || !!writeError" @click="cancelBatch">
        {{ cancelling ? '正在取消…' : '取消剩余候选' }}
      </button>
    </div>
    <p role="status" :class="notice ? 'studio-feedback' : 'sr-only'">{{ notice }}</p>
    <div v-if="completed.length" class="studio-results">
      <div class="studio-heading">
        <h3>本批候选</h3>
        <span v-if="frameActions && targetTitle" class="studio-caption">绑定到「{{ targetTitle }}」</span>
      </div>
      <ul class="studio-candidates">
        <li v-for="item in completed" :key="item.id">
          <StudioAssetThumb :version="item" /><span>{{ versionLabel(data, item.id) }}</span>
          <div v-if="draft.batch?.form.kind === 'outfit'" class="studio-actions">
            <button class="btn btn-ghost btn-sm" type="button" :disabled="locked" @click="reuseLook(item.id, 'scene')">用这套拍场景</button>
            <button class="btn btn-ghost btn-sm" type="button" :disabled="locked" @click="reuseLook(item.id, 'difference')">继续做表情</button>
            <button class="btn btn-ghost btn-sm" type="button" :disabled="locked || guide.lookVersionId === item.id" @click="reuseLook(item.id)">
              {{ guide.lookVersionId === item.id ? '当前造型' : '设为当前造型' }}
            </button>
          </div>
          <div v-if="frameActions" class="studio-actions">
            <button
              v-for="slot in slots"
              :key="slot.id"
              class="btn btn-ghost btn-sm"
              type="button"
              :disabled="!targetTitle || shotBusy"
              @click="$emit('bind', item.id, slot.id)"
            >
              {{ slot.label }}
            </button>
            <button v-if="draft.batch?.form.kind === 'keyframe'" class="btn btn-ghost btn-sm" type="button" :disabled="shotBusy" @click="$emit('add-shot', item.id)">
              加入短片镜头
            </button>
          </div>
        </li>
      </ul>
    </div>
  </section>
</template>
<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioAssetThumb from './StudioAssetThumb.vue'
import KeyframeGuide from './KeyframeGuide.vue'
import type {
  captureStudioProjectRepository,
  StudioProjectSnapshot,
  StudioAssetVersion,
  StudioAssetKind,
} from '@/storage/studioProjectRepository'
import { assetLabels, frameDragType, imageAccept, versionLabel } from './projectAssets'
import { candidateKinds, canvasSupported, canvases, variationLines, type GuideMode } from './keyframeDraft'
import { useGuidedKeyframes } from './useGuidedKeyframes'
import { useKeyframeWorkbench } from './useKeyframeWorkbench'
const props = defineProps<{
  data: StudioProjectSnapshot
  repo: ReturnType<typeof captureStudioProjectRepository>
  targetTitle: string
  shotBusy: boolean
  refresh: () => Promise<void>
  importFiles: (files: File[], kind?: StudioAssetKind) => Promise<string[]>
}>()
defineEmits<{ bind: [versionId: string, slot: 'first' | 'last']; 'add-shot': [versionId: string]; reload: [] }>()
const {
  draft,
  notice,
  writeError,
  modelError,
  models,
  model,
  preferredModel,
  loadingModels,
  saving,
  busy,
  cancelling,
  remaining,
  locked,
  loadModels,
  addReferences,
  moveReference,
  flushDraft,
  start,
  run,
  cancelBatch,
} = useKeyframeWorkbench(props)
const guideTools = useGuidedKeyframes(() => props.data, draft, preferredModel, locked)
const { guide, plan, issue: guideIssue, character, garmentOptions, faceOptions } = guideTools
const guideView = ref<InstanceType<typeof KeyframeGuide>>()
const advanced = ref<HTMLDetailsElement>()
const guideAction = computed(() => ({
  outfit: '生成 4 张衣装差分',
  difference: guide.value.difference === 'expression' ? '生成 4 张表情差分' : '生成 4 张动作差分',
  scene: '生成 4 张场景套图',
  neutral: '整理为干净立绘',
})[guide.value.mode])
const byId = (id: string) => props.data.versions.find((v) => v.id === id)
const completed = computed(() =>
  (draft.value.batch?.jobs || [])
    .filter((j) => j.state === 'done')
    .map((j) => byId(j.versionId))
    .filter((v): v is StudioAssetVersion => !!v)
)
const canvasOptions = computed(() => (Object.keys(canvases) as (keyof typeof canvases)[])
  .filter(value => !model.value || canvasSupported(model.value, value))
  .map(value => ({ value, label: canvases[value].label })))
const outputKinds = [...candidateKinds, 'character'].map((value) => ({
  value,
  label: assetLabels[value as keyof typeof assetLabels],
}))
const frameActions = computed(() => draft.value.batch?.form.kind === 'keyframe' || !draft.value.batch?.form.keyframe)
const countOptions = [1, 2, 3, 4].map((value) => ({ value, label: value + ' 张' }))
const variationCount = computed(() => variationLines(draft.value.form).length)
const slots = [
  { id: 'first', label: '用作首帧' },
  { id: 'last', label: '用作尾帧' },
] as const
const modelOptions = computed(() =>
  models.value.map((m) => ({ value: m.id, label: m.label + (m.available ? '' : ' · 待准备') }))
)
const referenceLimit = computed(() => model.value?.maxReferences ?? 4)
const fluxModelId = 'flux-kontext-dev'
const filePicker = ref<HTMLInputElement>(),
  importing = ref(false)
const guidePicker = ref<HTMLInputElement>()
let guideImportKind: 'character' | 'scene' | 'outfit' | 'expression' = 'character'
function pickGuidedFile(kind: typeof guideImportKind) {
  if (locked.value || importing.value) return
  guideImportKind = kind
  guidePicker.value?.click()
}
async function pickedGuidedFile(event: Event) {
  const input = event.currentTarget as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || locked.value || importing.value) return
  importing.value = true
  notice.value = ''
  try {
    const [id] = await props.importFiles([file], guideImportKind)
    if (!id) return
    if (guideImportKind === 'character') guideTools.update({ characterVersionId: id })
    else if (guideImportKind === 'scene') guideTools.update({ scene: 'scene/' + id })
    else if (guideImportKind === 'outfit') guideTools.update({ garmentVersionId: id })
    else guideTools.update({ faceVersionId: id })
  } catch (e) {
    notice.value = e instanceof Error ? e.message : '素材导入失败'
  } finally {
    importing.value = false
  }
}
function generateGuided() {
  const selected = plan.value
  if (selected && !guideIssue.value && preferredModel.value && !importing.value) void start(selected.form, selected.prepare)
}
function generateManual() {
  if (importing.value) return
  const { form, prepare } = guideTools.advancedPlan()
  void start(form, prepare)
}
function setModel(id: string) {
  if (locked.value || draft.value.form.modelId === id) return
  const form = draft.value.form
  form.modelId = id
  delete form.steps
  const canvas = canvasOptions.value[0]
  if (canvas && !canvasOptions.value.some(option => option.value === form.canvas)) form.canvas = canvas.value
}
function changeSteps(event: Event) {
  const input = event.currentTarget as HTMLInputElement
  if (!input.value) delete draft.value.form.steps
  else if (input.validity.valid) draft.value.form.steps = input.valueAsNumber
}
async function reuseLook(id: string, mode?: GuideMode) {
  if (locked.value) {
    notice.value = '完成或取消当前批次后可更换造型。'
    return
  }
  guideTools.useLook(id, mode)
  if (mode) {
    await nextTick()
    guideView.value?.focus()
  } else notice.value = `已选用「${versionLabel(props.data, id)}」。`
}
async function addFiles(files: File[]) {
  if (!files.length || locked.value || importing.value) return
  if (files.length + draft.value.form.references.length > referenceLimit.value) {
    notice.value = `最多可添加 ${referenceLimit.value} 张参考图。`
    return
  }
  importing.value = true
  notice.value = ''
  try {
    const ids = await props.importFiles(files)
    addReferences(ids)
  } catch (e) {
    notice.value = e instanceof Error ? e.message : '参考图导入失败'
  } finally {
    importing.value = false
  }
}
async function move(event: MouseEvent, index: number, step: number) {
  const button = event.currentTarget as HTMLButtonElement,
    row = button.closest('li'),
    id = draft.value.form.references[index]
  moveReference(index, step)
  await nextTick()
  const liveButton = button.disabled ? row?.querySelector<HTMLButtonElement>('[data-order]:not(:disabled)') : button
  liveButton?.focus({ preventScroll: true })
  row?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  if (id) notice.value = `${versionLabel(props.data, id)} 已移到第 ${index + step + 1} 位。`
}
function pickedFiles(event: Event) {
  const input = event.currentTarget as HTMLInputElement
  const files = Array.from(input.files || [])
  input.value = ''
  void addFiles(files)
}
function allowDrop(event: DragEvent) {
  if (event.dataTransfer?.types.some((t) => t === frameDragType || t === 'Files')) event.preventDefault()
}
function drop(event: DragEvent) {
  const drag = event.dataTransfer
  if (!drag) return
  event.preventDefault()
  notice.value = ''
  const id = drag.getData(frameDragType)
  if (id) addReferences([id])
  else void addFiles(Array.from(drag.files))
}
function openReferences(ids: string[]) {
  if (advanced.value) advanced.value.open = true
  addReferences(ids)
}
defineExpose({
  addReferences: openReferences, reuseLook, flushDraft,
  currentReferences: () => draft.value.form.references.filter(id => byId(id)),
})
</script>
