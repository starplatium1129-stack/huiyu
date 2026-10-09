import type { CompanionDesktopBridge } from '@/types/desktop'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import { useCompanionClipboardImport } from './useCompanionClipboardImport'
import { importLocalImages } from '@/utils/desktopImport'

vi.mock('@/utils/desktopImport', () => ({ importLocalImages: vi.fn(async () => ({ imported: 1, skipped: 0 })) }))
const capture = vi.hoisted(() => ({ resolve: (_value: string) => {} }))
vi.mock('@/utils/companionVision', () => ({
  captureScreenFrame: () => new Promise<string>(resolve => { capture.resolve = resolve }),
  blobToDataUrl: () => new Promise<string>(resolve => { capture.resolve = resolve }),
  getCharacterInspectionPrompt: (id: string) => id,
}))
let wrapper: ReturnType<typeof mount> | undefined
beforeEach(() => vi.mocked(importLocalImages).mockReset().mockResolvedValue({ imported: 1, skipped: 0 }))
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.restoreAllMocks() })
function setup() {
  let image = (_value: number[]) => {}, text = (_value: string) => {}
  const activeChar = ref('nene'), busy = ref(false), handleSend = vi.fn()
  const noteReturnPlain = vi.fn(), resetEventDetector = vi.fn(), notify = vi.fn()
  let api!: ReturnType<typeof useCompanionClipboardImport>
  const bridge = { onClipboardImage: (cb: typeof image) => { image = cb; return 1 },
    onClipboardText: (cb: typeof text) => { text = cb; return 2 }, offClipboardImage: vi.fn(), offClipboardText: vi.fn(), notify }
  wrapper = mount(defineComponent({ setup() {
    api = useCompanionClipboardImport({ activeChar, busy, chatReady: ref(true), handleSend,
      inputText: ref(''), desktopBridge: bridge as unknown as CompanionDesktopBridge,
      currentCharacterName: () => activeChar.value, persistDraft: vi.fn(), scrollChatToBottom: vi.fn(),
      noteReturn: vi.fn(), noteReturnPlain, resetEventDetector })
    return () => null
  } }))
  return { api, activeChar, busy, handleSend, noteReturnPlain, resetEventDetector, notify, image: (value: number[]) => image(value), text: (value: string) => text(value) }
}
it.each(['skipped', 'rejected'] as const)('retains a %s clipboard import for retry without claiming it was saved', async failure => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview')
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const f = setup(); f.image([1])
  if (failure === 'skipped') vi.mocked(importLocalImages).mockResolvedValueOnce({ imported: 0, skipped: 1 })
  else vi.mocked(importLocalImages).mockRejectedValueOnce(new Error('storage unavailable'))
  await f.api.acceptClipboardCard()
  expect(f.api.clipboardCard.value).toMatchObject({ previewUrl: 'blob:preview', saving: false })
  expect(f.api.clipboardCard.value?.error).toContain('尚未确认入册')
  expect(revoke).not.toHaveBeenCalled()
  expect(f.resetEventDetector).not.toHaveBeenCalled()
  expect(f.notify).not.toHaveBeenCalled()
  await f.api.acceptClipboardCard()
  expect(f.api.clipboardCard.value).toBeNull()
  expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:preview')
  expect(f.resetEventDetector).toHaveBeenCalledOnce()
})
it('blocks duplicate saves and leaves a newer clipboard card intact when the older save finishes', async () => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:old').mockReturnValueOnce('blob:new')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  let finish!: (value: { imported: number; skipped: number }) => void
  vi.mocked(importLocalImages).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  const f = setup(); f.image([1])
  const save = f.api.acceptClipboardCard()
  await f.api.acceptClipboardCard()
  expect(importLocalImages).toHaveBeenCalledOnce()
  expect(f.api.clipboardCard.value?.saving).toBe(true)
  f.image([2]); finish({ imported: 1, skipped: 0 }); await save
  expect(f.api.clipboardCard.value?.previewUrl).toBe('blob:new')
  expect(f.api.clipboardCard.value?.saving).toBeUndefined()
})
it('handles a rejected file import without an unhandled promise or a false success', async () => {
  const f = setup(), input = document.createElement('input')
  Object.defineProperty(input, 'files', { value: [new File(['fixture'], 'image.png', { type: 'image/png' })] })
  f.api.importInputRef.value = input
  vi.mocked(importLocalImages).mockRejectedValueOnce(new Error('maintenance lock unavailable'))
  f.api.onImportInputChange(); await flushPromises()
  expect(f.noteReturnPlain).toHaveBeenCalledWith(expect.stringContaining('尚未确认入册'))
  expect(f.resetEventDetector).not.toHaveBeenCalled()
})
it('releases every replaced clipboard preview, including replacement by text', () => {
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:first').mockReturnValueOnce('blob:second')
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const f = setup(); f.image([1]); f.image([2]); f.text('hello')
  expect(create).toHaveBeenCalledTimes(2)
  expect(revoke.mock.calls).toEqual([['blob:first'], ['blob:second']])
})
for (const operation of ['screen', 'clipboard'] as const) for (const interruption of ['character', 'unmount', 'busy'] as const) {
  it(`does not send a late ${operation} image after ${interruption}`, async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const f = setup(); f.image([1])
    const work = operation === 'screen' ? f.api.onCaptureAndInspectScreen() : f.api.inspectClipboardImage()
    if (interruption === 'character') { f.activeChar.value = 'natsume'; f.activeChar.value = 'nene' }
    if (interruption === 'unmount') { wrapper!.unmount(); wrapper = undefined }
    if (interruption === 'busy') f.busy.value = true
    capture.resolve('data:image/png;base64,fixture'); await work
    expect(f.handleSend).not.toHaveBeenCalled()
  })
}
it('sends a completed capture to the unchanged character', async () => {
  const f = setup(); const work = f.api.onCaptureAndInspectScreen()
  capture.resolve('data:image/png;base64,fixture'); await work
  expect(f.handleSend).toHaveBeenCalledWith('nene', 'data:image/png;base64,fixture')
})
