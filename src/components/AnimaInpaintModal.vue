<script setup lang="ts">
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import { resolveRuntimeUrl, runtimeResourceCors } from '@/platform/runtimeUrl'

import ToggleSwitch from '@/components/visual/ToggleSwitch.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import { computed, nextTick, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import type { ComfyNodeReadiness } from '@/types/anima'
import { automaticMaskBlocker } from '@/composables/generation/animaBackendReadiness'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import CornerFrame from '@/components/visual/CornerFrame.vue'
import { useToast } from '@/composables/useToast'
import { useInpaintMaskCanvas } from './inpaint/useInpaintMaskCanvas'
import { useInpaintImageSource, type InpaintSource } from './inpaint/useInpaintImageSource'
import { useInpaintOutfitPresets } from './inpaint/useInpaintOutfitPresets'
import { useInpaintPreparation } from './inpaint/useInpaintPreparation'

export interface InpaintSubmitPayload {
  editMode?: 'masked' | 'whole'
  imageBlob: Blob
  sourceHistoryId: string | number | null
  maskBlob: Blob | null
  maskPrompt: string
  maskThreshold: number
  newOutfitPrompt: string
  negativePrompt: string
  denoisingStrength: number
  growMaskBy: number
  seed: number | null
  characterOverride?: 'nene' | 'natsume' | 'triad' | 'none' | null
  targetWidth?: number
  targetHeight?: number
}

const props = defineProps<{
  provider?: 'comfy' | 'native'
  automaticMaskAvailable?: boolean
  automaticMaskStatus?: ComfyNodeReadiness
  managedStartAvailable?: boolean
  open: boolean
  imageSource: InpaintSource
  currentNegative?: string
  character?: 'nene' | 'natsume' | 'triad' | null
  seed?: number | null
  submitting?: boolean
  preparing?: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'whole-image', value: boolean): void
  (e: 'submit', payload: InpaintSubmitPayload): void
}>()

// The eager dialog owns focus and visibility; this form stays mounted for its draft.
const modalEl = ref<HTMLElement | null>(null)

const native = computed(() => props.provider === 'native')
const maskUnavailable = computed(() => automaticMaskBlocker(props))
const automaticMaskAllowed = computed(() => !maskUnavailable.value)
const editMode = ref<'masked' | 'whole'>('masked')
const wholeImage = computed(() => editMode.value === 'whole')
watch(wholeImage, value => emit('whole-image', value), { immediate: true })
async function returnToMask() {
  editMode.value = 'masked'
  await nextTick()
  if (props.open) modalEl.value?.querySelector<HTMLButtonElement>('.mask-mode-switch button[aria-pressed="true"]')?.focus()
}

const previewImageEl = ref<HTMLImageElement | null>(null)

// ── 手绘遮罩引擎（笔划/擦除/撤销/笔刷光标/空遮罩检测）已下沉
//    useInpaintMaskCanvas；Ctrl+Z 与 Alt+滚轮监听自持。──
const {
  maskCanvasEl,
  maskMode,
  brushSize,
  cursorVisible,
  brushCursorStyle,
  maskUndoCount,
  clearMask,
  undoMask,
  handleCanvasWheel,
  syncMaskCanvas,
  enterMaskCanvas,
  leaveMaskCanvas,
  startMaskPaint,
  continueMaskPaint,
  finishMaskPaint,
  stopMaskPaint,
  maskBlob,
} = useInpaintMaskCanvas({
  active: () => props.open && !wholeImage.value,
  opaquePaint: () => native.value,
  imageEl: previewImageEl,
  resolution: () => native.value ? null : detectedResolution.value,
})

if (props.automaticMaskAvailable !== true) maskMode.value = 'paint'
watch(native, value => { if (value) maskMode.value = 'paint'; syncMaskCanvas() }, { immediate: true })

// ── 图片源（上传/拖拽/blob 直通/URL 兜底）与画幅探测已下沉
//    useInpaintImageSource；blob URL 生命周期自持。──
const {
  activeImageUrl,
  previewSurfaceStyle,
  detectedResolution,
  imageReady,
  previewFailed,
  previewAttempt,
  sourceRevision,
  sourceHistoryId,
  onPreviewLoad,
  onPreviewError,
  retryPreview,
  uploadedBlob,
  fileInputRef,
  isDragging,
  triggerUpload,
  onFileChange,
  onDrop,
  getBlob,
} = useInpaintImageSource({
  open: () => props.open,
  source: () => props.imageSource,
  previewImage: () => previewImageEl.value,
  clearMask,
  syncMaskCanvas,
})

// ── 服装预设与 CLIPSeg/换装参数已下沉
//    useInpaintOutfitPresets。──
const {
  presets,
  currentPreset,
  selectedPresetId,
  customPrompt,
  maskPrompt,
  maskThreshold,
  denoisingStrength,
  growMaskBy,
  preserveSeed,
  characterMode,
} = useInpaintOutfitPresets({
  open: () => props.open,
})

const toast = useToast()

function captureDraft() {
  if (!wholeImage.value && maskMode.value !== 'paint' && maskUnavailable.value) {
    toast.error(maskUnavailable.value)
    return null
  }
  const newPrompt = customPrompt.value.trim()
  if (!newPrompt) {
    toast.error('请输入或选择目标服装描述')
    return null
  }

  const negative = props.currentNegative || 'worst quality, low quality'
  const finalNegative = currentPreset.value?.negativeAdd
    ? `${negative}, ${currentPreset.value.negativeAdd}`
    : negative

  const charOverride = characterMode.value === 'auto'
    ? (props.character ?? null)
    : characterMode.value

  return {
    editMode: editMode.value,
    painted: !wholeImage.value && maskMode.value === 'paint',
    sourceHistoryId: sourceHistoryId.value,
    maskPrompt: maskPrompt.value.trim() || 'clothing | clothes | outfit',
    maskThreshold: maskThreshold.value,
    newOutfitPrompt: newPrompt,
    negativePrompt: finalNegative,
    denoisingStrength: denoisingStrength.value,
    growMaskBy: growMaskBy.value,
    seed: preserveSeed.value ? (props.seed ?? null) : null,
    characterOverride: charOverride,
    targetWidth: detectedResolution.value?.width,
    targetHeight: detectedResolution.value?.height,
  }
}

const { preparing: readingSource, start: handleStart } = useInpaintPreparation({
  open: () => props.open, sourceRevision: () => sourceRevision.value,
  ready: () => imageReady.value, busy: () => Boolean(props.submitting),
  capture: captureDraft, getBlob, maskBlob,
  submit: payload => emit('submit', payload), error: message => toast.error(message),
})
</script>

<template>
    <div ref="modalEl" class="inpaint-content">
      <CornerFrame variant="ghost" />

      <!-- Hidden file input for uploading external image -->
      <input
        ref="fileInputRef"
        type="file"
        class="hidden-file-input"
        accept="image/png,image/jpeg,image/webp"
        @change="onFileChange"
      />

      <div class="inpaint-body">
      <p v-if="native && !wholeImage" class="modal-intro">局部重绘（实验性）：手绘或本地自动识别区域参与采样，遮罩外按原图合成保留。TeaCache 沿用生成参数，无需单独校准；具体换装效果仍取决于选区与重绘幅度。</p>
      <p v-if="wholeImage" class="modal-intro">整图重绘会重新生成整张图片，人物、面部和背景均可能变化，不保留遮罩外区域。</p>
      <p v-else-if="!native" class="modal-intro">
        <b>手绘精确遮罩</b>可指定要修改的衣物。<b>自动识别</b>（如 uniform / dress）需要额外文字蒙版节点，提交前会检查所用服务。
        热门角色换装已自动锁定角色身份，不会误绑桌宠 LoRA。
      </p>

      <div class="inpaint-layout">
        <!-- 左侧：原图预览与智能遮罩提示 -->
        <div class="inpaint-preview-col">
          <div
            class="preview-card"
            :class="{ 'is-dragover': isDragging, 'has-image': !!activeImageUrl }"
            @dragover.prevent="isDragging = true"
            @dragleave.prevent="isDragging = false"
            @drop.prevent="onDrop"
          >
            <template v-if="activeImageUrl">
              <span class="preview-label">
                {{ uploadedBlob ? '已导入外部图片' : '原图基准' }}
              </span>
              <div
                class="preview-surface"
                :style="previewSurfaceStyle"
                tabindex="-1" role="group" aria-label="原图预览" :aria-busy="!imageReady && !previewFailed"
              >
                <img decoding="async" :key="`${sourceRevision}:${previewAttempt}`" :data-source-revision="sourceRevision" :data-preview-attempt="previewAttempt" :crossorigin="runtimeResourceCors()" ref="previewImageEl" class="preview-thumb" :class="{ 'is-ready': imageReady }" :src="resolveRuntimeUrl(activeImageUrl)" alt="换装基准图" @load="onPreviewLoad" @error="onPreviewError" />
                <div v-if="!imageReady" class="preview-feedback" :role="previewFailed ? 'alert' : 'status'">
                  <ArchiveIcon :name="previewFailed ? 'warning' : 'image'" />
                  <span>{{ previewFailed ? '原图未能载入，可以重试或更换图片。' : '正在准备原图…' }}</span>
                  <button v-if="previewFailed" class="btn btn-ghost btn-sm" type="button" @click="previewImageEl?.parentElement?.focus({ preventScroll: true }); retryPreview()">重试原图</button>
                </div>
                <canvas
                  ref="maskCanvasEl"
                  class="mask-canvas"
                  :class="{ 'native-mask': native, hidden: wholeImage || maskMode !== 'paint' || !imageReady }"
                  aria-label="换装区域遮罩画布"
                  tabindex="0"
                  @contextmenu.prevent
                  @pointerenter="enterMaskCanvas"
                  @pointerleave="leaveMaskCanvas"
                  @pointerdown="startMaskPaint"
                  @pointermove="continueMaskPaint"
                  @pointerup="finishMaskPaint"
                  @pointercancel="stopMaskPaint"
                  @lostpointercapture="stopMaskPaint"
                  @wheel="handleCanvasWheel"
                ></canvas>
                <!-- 笔刷尺寸跟随光标圈 -->
                <div
                  v-if="imageReady && !wholeImage && maskMode === 'paint' && cursorVisible"
                  class="brush-cursor-indicator"
                  :style="brushCursorStyle"
                ></div>
              </div>
              <div class="preview-actions">
                <div class="preview-guidance">
                  <ArchiveIcon name="spark" />
                  <span>{{ wholeImage ? '整张图片都会参与重绘' : maskMode === 'paint' ? '涂白换装，Shift/右键保护' : '自动识别服装区域' }}</span>
                </div>
                <StudioTooltip content="选择或拖入其他本地图片">
                  <button class="btn btn-quiet btn-sm" type="button" @click="triggerUpload">
                    <ArchiveIcon name="upload" />
                    <span>更换外部图片</span>
                  </button>
                </StudioTooltip>
              </div>
            </template>

            <template v-else>
              <button class="dropzone-empty" data-control-motion type="button" aria-label="选择本地图片换装" @click="triggerUpload">
                <ArchiveIcon name="upload" class="dropzone-icon" />
                <span class="dropzone-title">点击或拖拽上传本地图片</span>
                <span class="dropzone-hint">支持 PNG / JPG / WebP 任意动漫图像</span>
              </button>
            </template>
          </div>

          <!-- 角色 LoRA 辅助模式 -->
          <div class="char-mode-box">
            <label class="field-label" for="charModeSelect">
              <span class="field-label-text">
                <ArchiveIcon name="character" />
                <span>角色模型辅助 (LoRA)</span>
              </span>
            </label>
            <StudioSelect
              id="charModeSelect"
              v-model="characterMode"
              label="角色模型辅助 (LoRA)"
              :options="[
                { value: 'auto', label: `自动跟随当前角色 (${character === 'nene' ? '宁宁' : character === 'natsume' ? '夏目' : character === 'triad' ? '宁宁与夏目' : '通用'})` },
                { value: 'none', label: '通用模式 (无 LoRA / 任意第三方动漫图)' },
                { value: 'nene', label: '绫地宁宁专属 LoRA (Ayachi Nene)' },
                { value: 'natsume', label: '四季夏目专属 LoRA (Shiki Natsume)' },
              ]"
            />
          </div>

          <div class="segment-box">
            <label class="field-label">
              <span class="field-label-text">
                <ArchiveIcon name="wand" />
                <span>重绘区域</span>
              </span>
            </label>
            <p v-if="native && !wholeImage" class="field-hint">{{ automaticMaskAllowed ? '本地 CLIPSeg 文件已就绪；首次使用时加载并校验模型，不会联网下载。' : '自动识别未就绪：请在配置的模型根目录下准备 clipseg-rd64-refined，包含配置、分词器及 model.safetensors；不会自动下载。手绘遮罩仍可使用。' }}</p>
            <p v-else-if="!native && !wholeImage" class="field-hint" role="status">{{ maskUnavailable || (automaticMaskAvailable ? '文字自动蒙版节点已注册；不代表其模型文件、加载或识别效果已验证。' : '自动识别节点尚未确认。明确选择自动识别后，提交时会启动受管服务并检查节点；未通过不会提交生成。') }}</p>
            <RouterLink v-if="!native && !wholeImage && maskUnavailable" class="btn btn-ghost" :to="{ path: '/control', query: { engine: 'anima' } }" @click="emit('close')">查看控制面板与准备范围</RouterLink>
            <button v-if="native || wholeImage" type="button" class="btn btn-ghost" :aria-pressed="wholeImage" @click="editMode = 'whole'">选择整图重绘（人物与背景均可能变化）</button>
            <button v-if="wholeImage" type="button" class="btn btn-ghost" @click="returnToMask">返回局部遮罩换装</button>
            <div v-if="!wholeImage" class="mask-mode-switch studio-segments studio-segments--compact" role="group" aria-label="遮罩模式">
              <AnimatedSelection />
              <button type="button" :aria-pressed="maskMode === 'paint'"
                @click="maskMode = 'paint'">手绘精确遮罩</button>
              <button type="button" :disabled="!automaticMaskAllowed" :aria-pressed="maskMode === 'auto'"
                @click="maskMode = 'auto'">自动识别</button>
            </div>
            <template v-if="!wholeImage && maskMode === 'paint'">
              <div class="brush-size-header">
                <label class="field-label" for="brushSizeInput">画笔大小 <span class="param-value">{{ brushSize }} px</span></label>
                <span class="wheel-shortcut-hint">Alt+滚轮缩放</span>
              </div>
              <input id="brushSizeInput" v-model.number="brushSize" class="slider" type="range" min="8" max="96" step="4" />
              <div class="mask-action-btns">
                <StudioTooltip anchor content="撤销上一步笔画 (Ctrl+Z)">
                  <button
                    type="button"
                    class="btn btn-ghost btn-sm"
                    :disabled="maskUndoCount === 0"
                    @click="undoMask"
                  >
                    <ArchiveIcon name="refresh" />
                    <span>撤销 <kbd>Ctrl+Z</kbd></span>
                  </button>
                </StudioTooltip>
                <button type="button" class="btn btn-quiet btn-sm" @click="clearMask">清空遮罩</button>
              </div>
              <span class="field-hint">
                涂白服装区域（支持 <kbd>Alt</kbd>+<kbd>滚轮</kbd> 调粗细；按住 <kbd>Shift</kbd> 或右键擦除保护五官手脚）。
              </span>
            </template>
            <template v-else-if="automaticMaskAllowed && !wholeImage">
              <label class="field-label" for="maskPromptInput">自动识别区域</label>
              <input id="maskPromptInput" v-model="maskPrompt" class="input" placeholder="clothing | clothes | outfit | dress | shirt..." />
              <div class="param-slider-group">
                <div class="param-header">
                  <span>识别灵敏度</span>
                  <span class="param-value">{{ maskThreshold.toFixed(2) }}</span>
                </div>
                <input
                  v-model.number="maskThreshold"
                  type="range"
                  min="0.20"
                  max="0.80"
                  step="0.05"
                  class="slider"
                  aria-label="自动识别阈值，越低识别区域越大"
                />
                <span class="slider-hint">偏低会误把身体/背景划进重绘区；推荐 0.45 ~ 0.60</span>
              </div>
              <span class="field-hint">仅作为快速起点。高质量换装建议使用手绘精确遮罩。</span>
            </template>
          </div>
        </div>

        <!-- 右侧：衣橱预设与参数设置 -->
        <div class="inpaint-options-col">
          <div class="presets-section">
            <span class="section-title">
              <ArchiveIcon name="wardrobe" />
              <span>选择目标服装形态</span>
            </span>

            <div class="preset-grid" role="group" aria-label="目标服装形态">
              <button
                v-for="p in presets"
                :key="p.id"
                type="button"
                :aria-pressed="selectedPresetId === p.id"
                class="preset-card"
                data-control-motion
                :class="{ 'is-nsfw': p.isNsfw }"
                @click="selectedPresetId = p.id"
              >
                <ArchiveIcon :name="p.icon" class="preset-icon" />
                <span class="preset-title">{{ p.label }}</span>
                <ArchiveIcon v-if="selectedPresetId === p.id" name="success" class="preset-check" />
              </button>
              <button
                type="button"
                :aria-pressed="selectedPresetId === 'custom'"
                class="preset-card"
                data-control-motion
                @click="selectedPresetId = 'custom'"
              >
                <ArchiveIcon name="palette" class="preset-icon" />
                <span class="preset-title">自由定制</span>
                <ArchiveIcon v-if="selectedPresetId === 'custom'" name="success" class="preset-check" />
              </button>
            </div>
          </div>

          <div class="field-block">
            <label class="field-label" for="promptDesc">
              <span>新服装描述词 (Prompt)</span>
              <small v-if="currentPreset" class="preset-desc-badge">{{ currentPreset.description }}</small>
            </label>
            <textarea
              id="promptDesc"
              v-model="customPrompt"
              class="textarea"
              rows="3"
              placeholder="例如：wearing white frilled bikini, swimsuit..."
            ></textarea>
          </div>

          <div class="params-row">
            <div class="param-slider-group">
              <div class="param-header">
                <span>重绘去噪幅度 (Denoise)</span>
                <span class="param-value">{{ denoisingStrength.toFixed(2) }}</span>
              </div>
              <input
                v-model.number="denoisingStrength"
                type="range"
                aria-label="重绘去噪幅度"
                min="0.50"
                max="0.98"
                step="0.01"
                class="slider"
              />
              <span class="slider-hint">越高换装越彻底（推荐 0.85 ~ 0.95）</span>
            </div>

            <div v-if="!wholeImage" class="param-slider-group">
              <div class="param-header">
                <span>{{ native ? '遮罩外扩 (Grow)' : '遮罩边缘羽化外扩 (Grow)' }}</span>
                <span class="param-value">{{ growMaskBy }} px</span>
              </div>
              <input
                v-model.number="growMaskBy"
                type="range"
                aria-label="遮罩边缘羽化外扩"
                min="0"
                max="24"
                step="2"
                class="slider"
              />
              <span class="slider-hint">{{ native ? '按输出像素向外扩展编辑区域，扩展区域也会参与重绘' : '防止衣物边缘与皮肤交界处出现硬边缝隙' }}</span>
            </div>
          </div>

            <ToggleSwitch v-model="preserveSeed" label="锁定原图 Seed" class="seed-toggle">
              <span>锁定原图 Seed ({{ seed ?? '随机' }}) 保持光影与环境色调高度一致</span>
            </ToggleSwitch>
        </div>
      </div>
      </div>

      <footer class="modal-footer">
        <button class="btn btn-ghost" type="button" :disabled="submitting && !preparing" @click="emit('close')">
          取消
        </button>
        <button class="btn btn-primary" type="button" :disabled="submitting || readingSource || !imageReady" @click="handleStart">
          <ArchiveIcon name="lightning" />
          <span>{{ preparing || readingSource ? '正在准备图片…' : submitting ? '正在生成…' : wholeImage ? '开始整图重绘' : native ? '开始手绘局部重绘（实验性）' : '开始智能换装' }}</span>
        </button>
      </footer>
    </div>
</template>

<style scoped src="@/assets/css/anima-inpaint.css"></style>
