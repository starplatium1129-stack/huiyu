import { runtimeFetch, resolveRuntimeUrl, runtimeResourceCors } from '../../platform/runtimeUrl.ts'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { inpaintCanvasSize } from '../../utils/inpaintCanvas.ts'
import { useToast } from '../../composables/useToast.ts'

export interface InpaintImageSourceDeps {
  open: () => boolean
  imageUrl: () => string | null | undefined
  imageBlob: () => Blob | null | undefined
  /** 图片更换后清空遮罩（useInpaintMaskCanvas.clearMask）。 */
  clearMask: () => void
  /** 画幅探测完成后重同步遮罩画布尺寸（useInpaintMaskCanvas.syncMaskCanvas）。 */
  syncMaskCanvas: () => void
}

/**
 * 局部换装弹窗「图片源 + 画幅探测」（2026-08-22 自 AnimaInpaintModal 下沉）。
 *
 * 三个来源的优先级：本地上传（拖拽/选择，blob URL 生命周期自持）→
  props.imageBlob（引擎结果直通）→ props.imageUrl 兜底 fetch。换图时
 * 用 Image onload 探测 naturalWidth/Height 并经 inpaintCanvasSize 收敛
 * 到受支持画幅，同时重置遮罩画布；关闭/卸载释放 blob URL。
 */
export function useInpaintImageSource(deps: InpaintImageSourceDeps) {
  const uploadedBlob = ref<Blob | null>(null)
  const uploadedUrl = ref<string>('')
  const fileInputRef = ref<HTMLInputElement | null>(null)
  const isDragging = ref(false)
  const detectedResolution = ref<{ width: number; height: number } | null>(null)

  const activeImageUrl = computed(() => uploadedUrl.value || deps.imageUrl() || '')

  // 自定义属性载体：预览画幅比例规则留在 scoped CSS，内联只承载数据（style-debt 门禁约定）
  const previewSurfaceStyle = computed(() => ({
    '--preview-ratio': detectedResolution.value ? `${detectedResolution.value.width} / ${detectedResolution.value.height}` : undefined,
  }))

  function clearUploadedImage() {
    if (uploadedUrl.value) URL.revokeObjectURL(uploadedUrl.value)
    uploadedBlob.value = null
    uploadedUrl.value = ''
    deps.clearMask()
  }

  function triggerUpload() {
    fileInputRef.value?.click()
  }

  function processUploadedFile(file: File) {
    if (!file.type.startsWith('image/')) {
      useToast().error('请选择有效的图片文件 (PNG, JPG, WebP)')
      return
    }
    uploadedBlob.value = file
    if (uploadedUrl.value) {
      URL.revokeObjectURL(uploadedUrl.value)
    }
    uploadedUrl.value = URL.createObjectURL(file)
  }

  function onFileChange(e: Event) {
    const target = e.target as HTMLInputElement
    const file = target.files?.[0]
    if (file) {
      processUploadedFile(file)
    }
    target.value = ''
  }

  function onDrop(e: DragEvent) {
    isDragging.value = false
    const file = e.dataTransfer?.files?.[0]
    if (file) {
      processUploadedFile(file)
    }
  }

  /** 提交用原图 blob：上传 > props.imageBlob > url 兜底拉取。 */
  async function getBlob(): Promise<Blob | null> {
    if (uploadedBlob.value) {
      return uploadedBlob.value
    }
    const propBlob = deps.imageBlob()
    if (propBlob && propBlob.size > 0) {
      return propBlob
    }
    if (activeImageUrl.value) {
      try {
        const res = await runtimeFetch(activeImageUrl.value, { cache: 'no-store' })
        if (!res.ok) return null
        return await res.blob()
      } catch {
        return null
      }
    }
    return null
  }

  watch(deps.open, (isOpen) => {
    if (isOpen) {
      clearUploadedImage()
    } else {
      clearUploadedImage()
    }
  })

  watch(activeImageUrl, (url) => {
    if (!url) {
      detectedResolution.value = null
      return
    }
    const img = new Image()
    img.crossOrigin = runtimeResourceCors() ?? null
    img.onload = () => {
      detectedResolution.value = inpaintCanvasSize(img.naturalWidth, img.naturalHeight)
      void nextTick(deps.syncMaskCanvas)
    }
    img.onerror = () => { detectedResolution.value = null }
    img.src = resolveRuntimeUrl(url)
  }, { immediate: true })

  onBeforeUnmount(() => {
    clearUploadedImage()
  })

  return {
    activeImageUrl,
    previewSurfaceStyle,
    detectedResolution,
    /** 本地上传的原图 blob（模板用它区分「已导入外部图片/原图基准」标签）。 */
    uploadedBlob,
    fileInputRef,
    isDragging,
    triggerUpload,
    onFileChange,
    onDrop,
    getBlob,
  }
}
