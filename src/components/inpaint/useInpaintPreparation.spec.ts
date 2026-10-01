import { afterEach, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { useInpaintImageSource } from './useInpaintImageSource'
import { useInpaintPreparation } from './useInpaintPreparation'

vi.mock('../../platform/runtimeUrl.ts', () => ({ runtimeFetch: vi.fn(), resolveRuntimeUrl: (url: string) => url, runtimeResourceCors: () => undefined }))
vi.mock('../../composables/useToast.ts', () => ({ useToast: () => ({ error: vi.fn() }) }))
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('waits for successful preview initialization and ignores obsolete or duplicate loads without clearing painted masks', async () => {
  const parentId = ref<string | number | null>('gallery-first')
  const url = ref('first'), open = ref(true), preview = ref<HTMLImageElement | null>(null)
  const clearMask = vi.fn(), syncMaskCanvas = vi.fn(() => true)
  let source!: ReturnType<typeof useInpaintImageSource>
  const wrapper = mount(defineComponent({ setup() {
    source = useInpaintImageSource({ open: () => open.value, source: () => ({ url: url.value, blob: null, historyId: parentId.value }),
      previewImage: () => preview.value, clearMask, syncMaskCanvas })
    return () => h('img', { key: source.sourceRevision.value, 'data-source-revision': source.sourceRevision.value, ref: preview, onLoad: source.onPreviewLoad })
  } }))
  const dimensions = (image: HTMLImageElement, width: number, height: number) => {
    Object.defineProperties(image, { naturalWidth: { value: width, configurable: true }, naturalHeight: { value: height, configurable: true } })
  }
  try {
    const staleImage = preview.value!
    dimensions(staleImage, 832, 1216)
    parentId.value = 'gallery-second'
    url.value = 'second'
    staleImage.dispatchEvent(new Event('load'))
    expect(syncMaskCanvas).not.toHaveBeenCalled()
    expect(clearMask).toHaveBeenCalledTimes(2)
    expect(source.detectedResolution.value).toBeNull()
    expect(source.imageReady.value).toBe(false)
    await nextTick()
    const image = preview.value!
    image.dispatchEvent(new Event('load'))
    expect(source.imageReady.value).toBe(false)
    expect(syncMaskCanvas).not.toHaveBeenCalled()
    dimensions(image, 1024, 1024)
    syncMaskCanvas.mockReturnValueOnce(false)
    image.dispatchEvent(new Event('load'))
    expect(source.imageReady.value).toBe(false)
    image.dispatchEvent(new Event('load'))
    expect(source.imageReady.value).toBe(true)
    expect(source.detectedResolution.value).toEqual({ width: 1024, height: 1024 })
    expect(source.sourceHistoryId.value).toBe('gallery-second')
    parentId.value = 'unrelated-later-id'
    expect(source.sourceHistoryId.value).toBe('gallery-second')
    // Once painting is enabled, no late load may resize/clear this canvas again.
    image.dispatchEvent(new Event('load')); staleImage.dispatchEvent(new Event('load'))
    expect(syncMaskCanvas).toHaveBeenCalledTimes(2)
    source.onDrop({ dataTransfer: { files: [new File(['synthetic'], 'fixture.png', { type: 'image/png' })] } } as unknown as DragEvent)
    expect(source.sourceHistoryId.value).toBeNull()
    expect(source.imageReady.value).toBe(false)
    image.dispatchEvent(new Event('load'))
    expect(syncMaskCanvas).toHaveBeenCalledTimes(2)
    open.value = false
    expect(source.detectedResolution.value).toBeNull()
  } finally { wrapper.unmount() }
})

it('freezes form and mask reads, prevents repeated submission, and cancels late reads on close or source change', async () => {
  const open = ref(true), revision = ref(0), prompt = ref('first outfit')
  const submit = vi.fn(), error = vi.fn(), maskBlob = vi.fn().mockResolvedValue(new Blob(['mask']))
  let finish!: (blob: Blob) => void
  let signal!: AbortSignal
  const getBlob = vi.fn((input: AbortSignal) => { signal = input; return new Promise<Blob>(resolve => { finish = resolve }) })
  let preparation!: ReturnType<typeof useInpaintPreparation>
  const wrapper = mount(defineComponent({ setup() {
    preparation = useInpaintPreparation({ open: () => open.value, sourceRevision: () => revision.value,
      ready: () => true, busy: () => false, adultEnabled: () => false, getBlob, maskBlob, submit, error,
      capture: () => ({ sourceHistoryId: 'original-parent', painted: true, requiresAdult: false, newOutfitPrompt: prompt.value, negativePrompt: '', maskPrompt: '', maskThreshold: 0.4, denoisingStrength: 0.8, growMaskBy: 8, seed: null }),
    })
    return () => h('div')
  } }))
  try {
    const pending = preparation.start()
    expect(maskBlob).toHaveBeenCalledOnce()
    prompt.value = 'changed outfit'
    await preparation.start()
    expect(getBlob).toHaveBeenCalledOnce()
    finish(new Blob(['first'])); await pending
    expect(submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ newOutfitPrompt: 'first outfit', sourceHistoryId: 'original-parent' }))
    for (const boundary of ['close', 'source']) {
      open.value = true
      const cancelled = preparation.start()
      if (boundary === 'close') open.value = false
      else revision.value++
      expect(signal.aborted).toBe(true)
      expect(preparation.preparing.value).toBe(false)
      finish(new Blob(['late'])); await cancelled
      expect(submit).toHaveBeenCalledTimes(1)
    }
    expect(error).not.toHaveBeenCalled()
  } finally { wrapper.unmount() }
})
