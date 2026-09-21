import { onMounted, onUnmounted, ref, watch, type Ref } from 'vue'
import type { CompanionDesktopBridge } from '@/types/desktop'
import { importLocalImages } from '@/utils/desktopImport'
import type { ImportSourceFile } from '@/utils/desktopImportCore'
import {
  captureScreenFrame,
  blobToDataUrl,
  getCharacterInspectionPrompt,
} from '@/utils/companionVision'

export interface CompanionClipboardImportDeps {
  activeChar: Ref<string>
  desktopBridge?: CompanionDesktopBridge
  currentCharacterName: () => string
  /** 带台词轮转的「回来」问候入队（useCompanionBehaviorRuntime.noteReturn）。 */
  noteReturn: (pickLine: (offset: number) => string) => void
  /** 固定话术入队（不轮转台词序号）。 */
  noteReturnPlain: (line: string) => void
  /** 入册后图片计数增加，重置事件检测器基线避免误报 sd-done。 */
  resetEventDetector: () => void
  inputText: Ref<string>
  /** 文本卡片「发给角色」落草稿（storage.setDraft）。 */
  persistDraft: (text: string) => void
  scrollChatToBottom: () => void
  handleSend: (text?: string, imageUrl?: string) => unknown
  busy: Ref<boolean>
  chatReady: Ref<boolean>
}

interface ClipboardCard {
  kind: 'image' | 'text'
  png?: Uint8Array | number[]
  previewUrl?: string
  text?: string
}

/**
 * 陪伴页「剪贴板 + 本地导入 + 看屏检视」簇（2026-08-22 自 CompanionView 下沉）。
 *
 * 桌面端剪贴板监听（图/文）→ 20s 自动消隐的浮卡：图片可入作品册或交给
 * 角色看图说话，文本可发给角色；窗口拖拽/隐藏 file input 走同一条
 * importLocalImages 入册路径。「看屏幕」按钮捕获屏幕帧送角色检视。
 * 剪贴板订阅、拖拽监听与浮卡计时器的生命周期由本 composable 自持。
 */
export function useCompanionClipboardImport(deps: CompanionClipboardImportDeps) {
  const { activeChar, desktopBridge } = deps

  const importInputRef = ref<HTMLInputElement>()
  const clipboardCard = ref<ClipboardCard | null>(null)
  const capturingScreen = ref(false)
  let clipboardCardTimer = 0
  let clipboardImageSubscription: number | undefined
  let clipboardTextSubscription: number | undefined
  let importBusy = false
  let alive = true
  let characterRevision = 0
  watch(activeChar, () => { characterRevision += 1 }, { flush: 'sync' })

  function showClipboardCard(card: ClipboardCard) {
    dismissClipboardCard()
    clipboardCard.value = card
    clearTimeout(clipboardCardTimer)
    clipboardCardTimer = window.setTimeout(dismissClipboardCard, 20_000) as unknown as number
  }

  function clipboardPngBlob(png: Uint8Array | number[]): Blob | null {
    try {
      const copy = png instanceof Uint8Array ? new Uint8Array(png) : new Uint8Array(png)
      return new Blob([copy.buffer as ArrayBuffer], { type: 'image/png' })
    } catch {
      return null
    }
  }

  function onClipboardImage(png: Uint8Array | number[]) {
    if (!alive) return
    const blob = clipboardPngBlob(png)
    if (!blob) return
    try {
      const previewUrl = URL.createObjectURL(blob)
      showClipboardCard({ kind: 'image', png, previewUrl })
    } catch { /* 大图/内存异常时忽略 */ }
  }

  function onClipboardText(text: string) {
    if (!alive) return
    showClipboardCard({ kind: 'text', text: text.slice(0, 400) })
  }

  function dismissClipboardCard() {
    clearTimeout(clipboardCardTimer)
    if (clipboardCard.value?.previewUrl) URL.revokeObjectURL(clipboardCard.value.previewUrl)
    clipboardCard.value = null
  }

  async function acceptClipboardCard() {
    const card = clipboardCard.value
    if (!card) return
    if (card.kind === 'image' && card.png) {
      const blob = clipboardPngBlob(card.png)
      dismissClipboardCard()
      if (!blob) return
      const { imported } = await importLocalImages([{ name: `剪贴板-${Date.now()}.png`, size: blob.size, type: 'image/png', blob }])
      if (imported > 0) {
        deps.noteReturnPlain('收到剪贴板里的图片，已经放进作品册啦。')
        if (desktopBridge) desktopBridge.notify(deps.currentCharacterName(), '图片已存入作品册')
        deps.resetEventDetector()
      }
    } else if (card.kind === 'text' && card.text) {
      const text = card.text
      dismissClipboardCard()
      deps.inputText.value = text
      deps.persistDraft(text)
      deps.scrollChatToBottom()
    }
  }

  async function handleImportedFiles(files: readonly ImportSourceFile[]) {
    if (importBusy || !files.length) return
    importBusy = true
    try {
      const { imported, skipped } = await importLocalImages(files)
      if (imported > 0) {
        const line = `收到 ${imported} 张图片，已经放进作品册啦${skipped > 0 ? `（${skipped} 张格式不支持）` : ''}。`
        deps.noteReturn(() => line)
        if (desktopBridge) desktopBridge.notify(deps.currentCharacterName(), line)
        // 导入也会让图片计数增加；重置检测器基线避免误报 sd-done
        deps.resetEventDetector()
      } else if (skipped > 0) {
        deps.noteReturnPlain('这几张图片好像打不开……再试试别的？')
      }
    } finally {
      importBusy = false
    }
  }

  function onImportInputChange() {
    const input = importInputRef.value
    const files = input?.files ? Array.from(input.files) : []
    if (input) input.value = ''
    void handleImportedFiles(files.map(file => ({ name: file.name, size: file.size, type: file.type, blob: file })))
  }

  function onWindowDrop(event: DragEvent) {
    const files = event.dataTransfer?.files
    if (!files || !files.length) return
    event.preventDefault()
    void handleImportedFiles(Array.from(files).map(file => ({ name: file.name, size: file.size, type: file.type, blob: file })))
  }

  function onWindowDragOver(event: DragEvent) {
    event.preventDefault()
  }

  async function onCaptureAndInspectScreen() {
    if (!alive || capturingScreen.value || deps.busy.value || !deps.chatReady.value) return
    const revision = characterRevision
    const character = activeChar.value
    capturingScreen.value = true
    try {
      const dataUrl = await captureScreenFrame()
      if (!dataUrl || !alive || revision !== characterRevision || deps.busy.value || !deps.chatReady.value) return
      const prompt = getCharacterInspectionPrompt(character)
      deps.handleSend(prompt, dataUrl)
    } catch {
      // 捕获异常忽略
    } finally {
      capturingScreen.value = false
    }
  }

  async function inspectClipboardImage() {
    if (!alive || deps.busy.value || !deps.chatReady.value) return
    const revision = characterRevision
    const character = activeChar.value
    const card = clipboardCard.value
    if (!card || card.kind !== 'image' || !card.png) return
    const blob = clipboardPngBlob(card.png)
    dismissClipboardCard()
    if (!blob) return
    try {
      const dataUrl = await blobToDataUrl(blob)
      if (!alive || revision !== characterRevision || deps.busy.value || !deps.chatReady.value) return
      const prompt = getCharacterInspectionPrompt(character)
      deps.handleSend(prompt, dataUrl)
    } catch {
      // 转换异常忽略
    }
  }

  onMounted(() => {
    window.addEventListener('dragover', onWindowDragOver, { passive: false })
    window.addEventListener('drop', onWindowDrop, { passive: false })
    if (desktopBridge) {
      clipboardImageSubscription = desktopBridge.onClipboardImage(onClipboardImage)
      clipboardTextSubscription = desktopBridge.onClipboardText(onClipboardText)
    }
  })

  onUnmounted(() => {
    alive = false
    clearTimeout(clipboardCardTimer)
    if (clipboardCard.value?.previewUrl) URL.revokeObjectURL(clipboardCard.value.previewUrl)
    window.removeEventListener('dragover', onWindowDragOver)
    window.removeEventListener('drop', onWindowDrop)
    if (desktopBridge && clipboardImageSubscription != null) desktopBridge.offClipboardImage(clipboardImageSubscription)
    if (desktopBridge && clipboardTextSubscription != null) desktopBridge.offClipboardText(clipboardTextSubscription)
  })

  return {
    importInputRef,
    clipboardCard,
    capturingScreen,
    onImportInputChange,
    dismissClipboardCard,
    acceptClipboardCard,
    onCaptureAndInspectScreen,
    inspectClipboardImage,
  }
}
