import type { CompanionDesktopBridge } from '@/types/desktop'
import { afterEach, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import { useCompanionClipboardImport } from './useCompanionClipboardImport'

vi.mock('@/utils/desktopImport', () => ({ importLocalImages: vi.fn(async () => ({ imported: 1, skipped: 0 })) }))
const capture = vi.hoisted(() => ({ resolve: (_value: string) => {} }))
vi.mock('@/utils/companionVision', () => ({
  captureScreenFrame: () => new Promise<string>(resolve => { capture.resolve = resolve }),
  blobToDataUrl: () => new Promise<string>(resolve => { capture.resolve = resolve }),
  getCharacterInspectionPrompt: (id: string) => id,
}))
let wrapper: ReturnType<typeof mount> | undefined
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.restoreAllMocks() })
function setup() {
  let image = (_value: number[]) => {}, text = (_value: string) => {}
  const activeChar = ref('nene'), busy = ref(false), handleSend = vi.fn()
  let api!: ReturnType<typeof useCompanionClipboardImport>
  const bridge = { onClipboardImage: (cb: typeof image) => { image = cb; return 1 },
    onClipboardText: (cb: typeof text) => { text = cb; return 2 }, offClipboardImage: vi.fn(), offClipboardText: vi.fn() }
  wrapper = mount(defineComponent({ setup() {
    api = useCompanionClipboardImport({ activeChar, busy, chatReady: ref(true), handleSend,
      inputText: ref(''), desktopBridge: bridge as unknown as CompanionDesktopBridge,
      currentCharacterName: () => activeChar.value, persistDraft: vi.fn(), scrollChatToBottom: vi.fn(),
      noteReturn: vi.fn(), noteReturnPlain: vi.fn(), resetEventDetector: vi.fn() })
    return () => null
  } }))
  return { api, activeChar, busy, handleSend, image: (value: number[]) => image(value), text: (value: string) => text(value) }
}
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
