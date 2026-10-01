import { afterEach, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { useInpaintImageSource } from './useInpaintImageSource'
import { useInpaintPreparation } from './useInpaintPreparation'

vi.mock('../../platform/runtimeUrl.ts', () => ({ runtimeFetch: vi.fn(), resolveRuntimeUrl: (url: string) => url, runtimeResourceCors: () => undefined }))
vi.mock('../../composables/useToast.ts', () => ({ useToast: () => ({ error: vi.fn() }) }))
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('rejects obsolete decode callbacks and clears source dimensions and mask before the new image loads', async () => {
  const probes: Array<{ onload: (() => void) | null; onerror: (() => void) | null; naturalWidth: number; naturalHeight: number }> = []
  vi.stubGlobal('Image', class {
    onload = null; onerror = null; naturalWidth = 832; naturalHeight = 1216
    constructor() { probes.push(this) }
  })
  const parentId = ref<string | number | null>('gallery-first')
  const url = ref('first'), open = ref(true), clearMask = vi.fn(), syncMaskCanvas = vi.fn()
  let source!: ReturnType<typeof useInpaintImageSource>
  const wrapper = mount(defineComponent({ setup() {
    source = useInpaintImageSource({ open: () => open.value, source: () => ({ url: url.value, blob: null, historyId: parentId.value }), clearMask, syncMaskCanvas })
    return () => h('div')
  } }))
  try {
    const staleLoad = probes[0]!.onload!, staleError = probes[0]!.onerror!
    parentId.value = 'gallery-second'
    url.value = 'second'
    expect(clearMask).toHaveBeenCalledTimes(2)
    expect(source.detectedResolution.value).toBeNull()
    expect(source.imageReady.value).toBe(false)
    probes[1]!.naturalWidth = 1024; probes[1]!.naturalHeight = 1024
    probes[1]!.onload!(); await nextTick()
    expect(source.detectedResolution.value).toEqual({ width: 1024, height: 1024 })
    expect(source.imageReady.value).toBe(true)
    expect(source.sourceHistoryId.value).toBe('gallery-second')
    parentId.value = 'unrelated-later-id'
    expect(source.sourceHistoryId.value).toBe('gallery-second')
    source.onDrop({ dataTransfer: { files: [new File(['synthetic'], 'fixture.png', { type: 'image/png' })] } } as unknown as DragEvent)
    expect(source.sourceHistoryId.value).toBeNull()
    probes[2]!.naturalWidth = 1024; probes[2]!.naturalHeight = 1024
    probes[2]!.onload!(); await nextTick()
    staleLoad(); staleError(); await nextTick()
    expect(source.detectedResolution.value).toEqual({ width: 1024, height: 1024 })
    expect(syncMaskCanvas).toHaveBeenCalledTimes(2)
    open.value = false
    expect(source.imageReady.value).toBe(false)
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
