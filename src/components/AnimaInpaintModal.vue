<script setup lang="ts">
import FluidTransition from "@/components/visual/FluidTransition.vue"
import ToggleSwitch from '@/components/visual/ToggleSwitch.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import { ref } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import CornerFrame from '@/components/visual/CornerFrame.vue'
import { useFocusTrap } from '@/composables/useFocusTrap'
import { useToast } from '@/composables/useToast'
import { useInpaintMaskCanvas } from './inpaint/useInpaintMaskCanvas'
import { useInpaintImageSource } from './inpaint/useInpaintImageSource'
import { useInpaintOutfitPresets } from './inpaint/useInpaintOutfitPresets'
import '@/assets/css/director/components/AnimaInpaintModal.css'

export interface InpaintSubmitPayload {
  imageBlob: Blob
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
  open: boolean
  imageUrl?: string | null
  imageBlob?: Blob | null
  currentPrompt?: string
  currentNegative?: string
  character?: 'nene' | 'natsume' | 'triad' | null
  adultEnabled?: boolean
  seed?: number | null
  submitting?: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'submit', payload: InpaintSubmitPayload): void
}>()

const modalEl = ref<HTMLElement | null>(null)
useFocusTrap(modalEl, () => props.open, { onEscape: () => emit('close') })

const previewImageEl = ref<HTMLImageElement | null>(null)

// ── 手绘遮罩引擎（笔划/擦除/撤销/笔刷光标/空遮罩检测）已下沉
//    useInpaintMaskCanvas；Ctrl+Z 与 Alt+滚轮监听自持。──
const {
  maskCanvasEl,
  maskMode,
  brushSize,
  cursorVisible,
  brushCursorStyle,
  maskHistory,
  clearMask,
  undoMask,
  handleCanvasWheel,
  syncMaskCanvas,
  startMaskPaint,
  continueMaskPaint,
  stopMaskPaint,
  maskBlob,
} = useInpaintMaskCanvas({
  active: () => props.open,
  imageEl: previewImageEl,
  resolution: () => detectedResolution.value,
})

// ── 图片源（上传/拖拽/blob 直通/URL 兜底）与画幅探测已下沉
//    useInpaintImageSource；blob URL 生命周期自持。──
const {
  activeImageUrl,
  previewSurfaceStyle,
  detectedResolution,
  uploadedBlob,
  fileInputRef,
  isDragging,
  triggerUpload,
  onFileChange,
  onDrop,
  getBlob,
} = useInpaintImageSource({
  open: () => props.open,
  imageUrl: () => props.imageUrl,
  imageBlob: () => props.imageBlob,
  clearMask,
  syncMaskCanvas,
})

// ── 服装预设（NSFW fail-closed）与 CLIPSeg/换装参数已下沉
//    useInpaintOutfitPresets。──
const {
  presets,
  visiblePresets,
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
  adultEnabled: () => props.adultEnabled,
  open: () => props.open,
})

const toast = useToast()

async function handleStart() {
  const blob = await getBlob()
  if (!blob) {
    toast.error('请先上传或选择需要换装的图片')
    return
  }

  const selectedMaskBlob = await maskBlob()
  if (maskMode.value === 'paint' && !selectedMaskBlob) {
    toast.error('请先在图片上涂出需要换装的区域，按住 Shift 或右键可擦除保护区')
    return
  }

  const selectedPreset = presets.find(preset => preset.id === selectedPresetId.value)
  if (selectedPreset?.isNsfw && !props.adultEnabled) {
    toast.error('请先在工作台开启分级内容，才能使用该服装预设')
    return
  }

  const newPrompt = customPrompt.value.trim()
  if (!newPrompt) {
    toast.error('请输入或选择目标服装描述')
    return
  }

  const negative = props.currentNegative || 'worst quality, low quality'
  const finalNegative = currentPreset.value?.negativeAdd
    ? `${negative}, ${currentPreset.value.negativeAdd}`
    : negative

  const charOverride = characterMode.value === 'auto'
    ? (props.character ?? null)
    : characterMode.value

  emit('submit', {
    imageBlob: blob,
    maskBlob: selectedMaskBlob,
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
  })
}
</script>

<template>
  <FluidTransition>
  <div v-if="open" class="modal-backdrop" @click.self="emit('close')">
    <div ref="modalEl" class="modal-card inpaint-modal" role="dialog" aria-modal="true" aria-label="智能局部换装">
      <CornerFrame variant="ghost" />

      <!-- Hidden file input for uploading external image -->
      <input
        ref="fileInputRef"
        type="file"
        class="hidden-file-input"
        accept="image/png,image/jpeg,image/webp"
        @change="onFileChange"
      />

      <header class="modal-header">
        <div class="header-title">
          <span class="header-badge">
            <ArchiveIcon name="lightning" />
            <span>TeaCache 加速</span>
          </span>
          <h2>
            <ArchiveIcon name="wardrobe" />
            <span>智能视觉换装 (AI Inpaint)</span>
          </h2>
        </div>
        <button class="btn btn-ghost btn-xs btn-close" type="button" aria-label="关闭" @click="emit('close')">
          <ArchiveIcon name="close" />
        </button>
      </header>

      <p class="modal-intro">
        默认<b>自动识别</b>服装区域（输入服装词即可，如 uniform / dress）；<b>手绘精确遮罩</b>可随时切回做局部微调。
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
              >
                <img ref="previewImageEl" class="preview-thumb" :src="activeImageUrl" alt="换装基准图" @load="syncMaskCanvas" />
                <canvas
                  ref="maskCanvasEl"
                  class="mask-canvas"
                  :class="{ hidden: maskMode !== 'paint' }"
                  aria-label="换装区域遮罩画布"
                  @contextmenu.prevent
                  @pointerenter="cursorVisible = true"
                  @pointerleave="cursorVisible = false; stopMaskPaint()"
                  @pointerdown="startMaskPaint"
                  @pointermove="continueMaskPaint"
                  @pointerup="stopMaskPaint"
                  @pointercancel="stopMaskPaint"
                  @wheel="handleCanvasWheel"
                ></canvas>
                <!-- 笔刷尺寸跟随光标圈 -->
                <div
                  v-if="maskMode === 'paint' && cursorVisible"
                  class="brush-cursor-indicator"
                  :style="brushCursorStyle"
                ></div>
              </div>
              <div class="preview-overlay-tag">
                <ArchiveIcon name="spark" />
                <span>{{ maskMode === 'paint' ? '涂白换装，Shift/右键保护' : '自动识别服装区域' }}</span>
              </div>
              <StudioTooltip content="选择或拖入其他本地图片">
                <button
                  class="btn btn-xs btn-upload-overlay"
                  type="button"
                  @click="triggerUpload"
                >
                  <ArchiveIcon name="upload" />
                  <span>更换外部图片</span>
                </button>
              </StudioTooltip>
            </template>

            <template v-else>
              <button class="dropzone-empty" type="button" aria-label="选择本地图片换装" @click="triggerUpload">
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
                { value: 'auto', label: `自动跟随当前角色 (${character || '通用'})` },
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
            <div class="mask-mode-switch" role="group" aria-label="遮罩模式">
              <button type="button" :class="{ active: maskMode === 'paint' }" @click="maskMode = 'paint'">手绘精确遮罩</button>
              <button type="button" :class="{ active: maskMode === 'auto' }" @click="maskMode = 'auto'">自动识别</button>
            </div>
            <template v-if="maskMode === 'paint'">
              <div class="brush-size-header">
                <label class="field-label" for="brushSizeInput">画笔大小 <span class="param-value">{{ brushSize }} px</span></label>
                <span class="wheel-shortcut-hint">Alt+滚轮缩放</span>
              </div>
              <input id="brushSizeInput" v-model.number="brushSize" class="slider" type="range" min="8" max="96" step="4" />
              <div class="mask-action-btns">
                <StudioTooltip anchor content="撤销上一步笔画 (Ctrl+Z)">
                  <button
                    type="button"
                    class="btn btn-ghost btn-xs"
                    :disabled="maskHistory.length === 0"
                    @click="undoMask"
                  >
                    <ArchiveIcon name="refresh" />
                    <span>撤销 <kbd>Ctrl+Z</kbd></span>
                  </button>
                </StudioTooltip>
                <button type="button" class="btn btn-ghost btn-xs btn-clear-mask" @click="clearMask">清空遮罩</button>
              </div>
              <span class="field-hint">
                涂白服装区域（支持 <kbd>Alt</kbd>+<kbd>滚轮</kbd> 调粗细；按住 <kbd>Shift</kbd> 或右键擦除保护五官手脚）。
              </span>
            </template>
            <template v-else>
              <label class="field-label" for="maskPromptInput">自动识别区域</label>
              <input id="maskPromptInput" v-model="maskPrompt" class="input input-sm" placeholder="clothing | clothes | outfit | dress | shirt..." />
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

            <div class="preset-grid">
              <button
                v-for="p in visiblePresets"
                :key="p.id"
                type="button"
                class="preset-card"
                :class="{ active: selectedPresetId === p.id, 'is-nsfw': p.isNsfw }"
                @click="selectedPresetId = p.id"
              >
                <ArchiveIcon :name="p.icon" class="preset-icon" />
                <span class="preset-title">{{ p.label }}</span>
              </button>
              <button
                type="button"
                class="preset-card custom-card"
                :class="{ active: selectedPresetId === 'custom' }"
                @click="selectedPresetId = 'custom'"
              >
                <ArchiveIcon name="palette" class="preset-icon" />
                <span class="preset-title">自由定制</span>
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
              class="textarea prompt-textarea"
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
                min="0.50"
                max="0.98"
                step="0.02"
                class="slider"
              />
              <span class="slider-hint">越高换装越彻底（推荐 0.85 ~ 0.95）</span>
            </div>

            <div class="param-slider-group">
              <div class="param-header">
                <span>遮罩边缘羽化外扩 (Grow)</span>
                <span class="param-value">{{ growMaskBy }} px</span>
              </div>
              <input
                v-model.number="growMaskBy"
                type="range"
                min="0"
                max="24"
                step="2"
                class="slider"
              />
              <span class="slider-hint">防止衣物边缘与皮肤交界处出现硬边缝隙</span>
            </div>
          </div>

          <div class="seed-option-row">
            <ToggleSwitch v-model="preserveSeed" label="锁定原图 Seed" class="seed-toggle">
              <span>锁定原图 Seed ({{ seed ?? '随机' }}) 保持光影与环境色调高度一致</span>
            </ToggleSwitch>
          </div>
        </div>
      </div>

      <footer class="modal-footer">
        <button class="btn btn-ghost" type="button" :disabled="submitting" @click="emit('close')">
          取消
        </button>
        <button class="btn btn-primary btn-submit-inpaint" type="button" :disabled="submitting || !activeImageUrl" @click="handleStart">
          <ArchiveIcon name="lightning" />
          <span>{{ submitting ? '正在换装中…' : '开始智能换装 (~6秒)' }}</span>
        </button>
      </footer>
    </div>
  </div>
  </FluidTransition>
</template>

<style scoped src="@/assets/css/anima-inpaint.css"></style>
