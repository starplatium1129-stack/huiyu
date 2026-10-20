import { onMounted, onUnmounted, ref, watch, type Ref } from 'vue'
import type { CompanionDesktopBridge } from '@/types/desktop'
import { importLocalImages, retryLocalImageImport } from '@/utils/desktopImport'
import { useLocalImageImportRecovery } from './useLocalImageImportRecovery'
import { imageMediaSession } from '../platform/imageMediaSession'
import { onDesktopRuntime } from '../platform/desktop/runtime'
import type { ImportSourceFile } from '@/utils/desktopImportCore'
import {
  captureScreenFrame,
  imageForInspection,
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
  listenClipboard?: boolean
  importOnDrop?: boolean
  isActive?: () => boolean
  onError?: (message: string) => void
}

interface ClipboardCard {
  kind: 'image' | 'text'
  imageBlob?: Blob
  previewUrl?: string
  text?: string
  saving?: boolean
  error?: string
  importId?: string
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
  let captureController: AbortController | null = null
  let inspectionController: AbortController | null = null
  let picker: { invalid: boolean; stop(): void } | undefined
  const importRecovery = useLocalImageImportRecovery(() => {
    if (!alive) return
    deps.noteReturnPlain('原图片已经确认放进作品册啦，没有重复导入。')
    deps.resetEventDetector()
  })
  const active = () => alive && (deps.isActive?.() ?? true)
  function importFeedbackAccess() {
    const session = imageMediaSession()
    let current = true
    const stop = onDesktopRuntime(() => { if (imageMediaSession() !== session) current = false })
    return { current: () => alive && current, stop }
  }
  watch(activeChar, () => { characterRevision += 1; cancelCapture(); dismissClipboardCard() }, { flush: 'sync' })

  function showClipboardCard(card: ClipboardCard) {
    dismissClipboardCard()
    clipboardCard.value = card
    clearTimeout(clipboardCardTimer)
    clipboardCardTimer = window.setTimeout(dismissClipboardCard, 20_000) as unknown as number
  }

  function clipboardPngBlob(png: Uint8Array | number[]): Blob | null {
    if (!png.length || png.length > 15 * 1024 * 1024) { deps.onError?.('剪贴板图片超过 15 MB，请缩小图片后重试。'); return null }
    try {
      const copy = png instanceof Uint8Array ? new Uint8Array(png) : new Uint8Array(png)
      return new Blob([copy.buffer as ArrayBuffer], { type: 'image/png' })
    } catch {
      return null
    }
  }

  function onClipboardImage(png: Uint8Array | number[]) {
    if (!active()) return
    const blob = clipboardPngBlob(png)
    if (!blob) return
    try {
      const previewUrl = URL.createObjectURL(blob)
      showClipboardCard({ kind: 'image', imageBlob: blob, previewUrl })
    } catch { /* 大图/内存异常时忽略 */ }
  }

  function onClipboardText(text: string) {
    if (!active() || !text.trim()) return
    showClipboardCard({ kind: 'text', text: text.slice(0, 1200), ...(text.length > 1200 ? { error: '仅填入前 1200 字，较长内容请分段发送。' } : {}) })
  }

  function dismissClipboardCard() {
    inspectionController?.abort(); inspectionController = null
    clearTimeout(clipboardCardTimer)
    if (clipboardCard.value?.previewUrl) URL.revokeObjectURL(clipboardCard.value.previewUrl)
    clipboardCard.value = null
  }

  async function acceptClipboardCard() {
    const card = clipboardCard.value
    if (!alive || !card || card.saving) return
    if (card.kind === 'image' && card.imageBlob) {
      const blob = card.imageBlob
      clearTimeout(clipboardCardTimer)
      if (!blob) { card.error = '图片暂时无法读取，请重新复制后重试。'; return }
      card.saving = true; card.error = ''
      const feedback = importFeedbackAccess()
      try {
        const extension = blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/webp' ? 'webp' : 'png'
        let imported = 0
        if (card.importId) {
          const outcome = await retryLocalImageImport(card.importId, blob)
          if (outcome !== 'saved') {
            if (clipboardCard.value === card) dismissClipboardCard()
            if (feedback.current()) deps.noteReturnPlain('原导入已结束，未重新创建作品。')
            return
          }
          imported = 1
        }
        else {
          const result = await importLocalImages([{ name: `剪贴板-${Date.now()}.${extension}`, size: blob.size, type: blob.type, blob }])
          imported = result.imported
          card.importId = result.pending[0]
        }
        if (!feedback.current()) return
        if (imported > 0) {
          if (clipboardCard.value === card) dismissClipboardCard()
          deps.noteReturnPlain('收到剪贴板里的图片，已经放进作品册啦。')
          if (desktopBridge) desktopBridge.notify(deps.currentCharacterName(), '图片已存入作品册')
          deps.resetEventDetector()
        } else if (clipboardCard.value === card) card.error = card.importId ? '原导入编号已保留，可从图片导入恢复入口继续；不会重复创建作品。' : '图片未导入，请检查图片格式与大小后重试。'
      } catch (error) {
        if (alive && clipboardCard.value === card) card.error = error instanceof Error ? error.message : '图片尚未确认入册，请使用图片导入恢复入口继续原导入。'
      } finally { feedback.stop(); if (clipboardCard.value === card) card.saving = false }
    } else if (card.kind === 'text' && card.text) {
      const text = card.text
      const combined = deps.inputText.value.trim() ? `${deps.inputText.value.trimEnd()}\n${text}` : text
      if (combined.length > 1200) { clearTimeout(clipboardCardTimer); card.error = '输入框剩余空间不足，请先发送或清理现有草稿，再填入剪贴板内容。'; return }
      dismissClipboardCard()
      deps.inputText.value = combined
      deps.persistDraft(deps.inputText.value)
      deps.scrollChatToBottom()
    }
  }

  async function handleImportedFiles(files: readonly ImportSourceFile[]) {
    if (importBusy || !files.length) return
    importBusy = true
    const feedback = importFeedbackAccess()
    try {
      const { imported, skipped, pending } = await importLocalImages(files)
      if (!feedback.current()) return
      if (imported > 0) {
        const line = `收到 ${imported} 张图片，已经放进作品册啦${skipped > 0 ? `（${skipped} 张未导入）` : ''}。${pending.length ? `还有 ${pending.length} 张待确认，请从图片导入恢复入口继续。` : ''}`
        deps.noteReturn(() => line)
        if (desktopBridge) desktopBridge.notify(deps.currentCharacterName(), line)
        // 导入也会让图片计数增加；重置检测器基线避免误报 sd-done
        deps.resetEventDetector()
      } else if (pending.length) deps.noteReturnPlain(`${pending.length} 张图片待确认，原编号已保留；请从图片导入恢复入口继续。`)
      else if (skipped > 0) deps.noteReturnPlain('这些文件未导入，请检查图片格式与大小；每批最多 8 张，每张不超过 24 MB。')
    } catch (error) {
      if (alive) deps.noteReturnPlain(error instanceof Error ? error.message : '图片尚未确认入册，请使用图片导入恢复入口继续原导入。')
    } finally {
      feedback.stop()
      importBusy = false
    }
  }

  function onImportInputChange() {
    const selected = picker
    picker = undefined; selected?.stop()
    const input = importInputRef.value
    const files = input?.files ? Array.from(input.files) : []
    if (input) input.value = ''
    if (!selected || selected.invalid) {
      if (files.length) deps.noteReturnPlain('选择文件期间资料连接已变化，请重新选择；尚未开始导入。')
      return
    }
    void handleImportedFiles(files.map(file => ({ name: file.name, size: file.size, type: file.type, blob: file })))
  }
  function openImportPicker() {
    picker?.stop()
    const session = imageMediaSession(), selected = { invalid: false, stop: () => {} }
    picker = selected
    selected.stop = onDesktopRuntime(() => { if (imageMediaSession() !== session) selected.invalid = true })
    importInputRef.value?.click()
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
    if (!active() || capturingScreen.value || clipboardCard.value?.saving || deps.busy.value || !deps.chatReady.value) return
    const revision = characterRevision
    const character = activeChar.value
    capturingScreen.value = true
    const controller = new AbortController(); captureController = controller
    try {
      const dataUrl = await captureScreenFrame(controller.signal)
      if (!dataUrl || !active() || controller.signal.aborted || revision !== characterRevision || deps.busy.value || !deps.chatReady.value) return
      const prompt = getCharacterInspectionPrompt(character)
      await deps.handleSend(prompt, dataUrl)
    } catch (error) {
      if (!controller.signal.aborted && alive) deps.onError?.(error instanceof DOMException && error.name === 'NotAllowedError'
        ? '分享屏幕已取消或未获允许。' : error instanceof Error ? error.message : '看屏幕失败，请重试。')
    } finally {
      if (captureController === controller) { capturingScreen.value = false; captureController = null }
    }
  }

  async function inspectClipboardImage() {
    if (!active() || capturingScreen.value || deps.busy.value || !deps.chatReady.value) { deps.onError?.('请先连接支持图片的聊天模型，并等待当前操作完成。'); return }
    const revision = characterRevision
    const card = clipboardCard.value
    if (!card || card.saving || card.kind !== 'image' || !card.imageBlob) return
    const blob = card.imageBlob
    if (!blob) return
    const controller = new AbortController(); inspectionController = controller
    const current = () => active() && inspectionController === controller && !controller.signal.aborted
      && clipboardCard.value === card && revision === characterRevision
    clearTimeout(clipboardCardTimer); card.saving = true; card.error = ''
    try {
      const dataUrl = await imageForInspection(blob, controller.signal)
      if (!current() || deps.busy.value || !deps.chatReady.value) return
      await deps.handleSend('（这是我复制的图片）请结合画面回答。', dataUrl)
      if (current()) dismissClipboardCard()
    } catch (error) { if (current()) card.error = error instanceof Error ? error.message : '图片发送失败，请重试。' }
    finally {
      if (inspectionController === controller) inspectionController = null
      if (clipboardCard.value === card) card.saving = false
    }
  }

  function cancelCapture() { captureController?.abort(); inspectionController?.abort(); captureController = null; capturingScreen.value = false }
  function onPaste(event: ClipboardEvent) {
    if (!active()) return
    const file = Array.from(event.clipboardData?.files || []).find(file => ['image/png', 'image/jpeg', 'image/webp'].includes(file.type))
    if (!file || file.size > 15 * 1024 * 1024) return
    event.preventDefault()
    showClipboardCard({ kind: 'image', imageBlob: file, previewUrl: URL.createObjectURL(file) })
  }

  onMounted(() => {
    if (deps.importOnDrop !== false) {
      window.addEventListener('dragover', onWindowDragOver, { passive: false })
      window.addEventListener('drop', onWindowDrop, { passive: false })
    }
    if (deps.listenClipboard !== false) window.addEventListener('paste', onPaste)
    if (desktopBridge && deps.listenClipboard !== false) {
      clipboardImageSubscription = desktopBridge.onClipboardImage(onClipboardImage)
      clipboardTextSubscription = desktopBridge.onClipboardText(onClipboardText)
    }
  })

  onUnmounted(() => {
    alive = false
    picker?.stop()
    cancelCapture()
    clearTimeout(clipboardCardTimer)
    if (clipboardCard.value?.previewUrl) URL.revokeObjectURL(clipboardCard.value.previewUrl)
    window.removeEventListener('dragover', onWindowDragOver)
    window.removeEventListener('drop', onWindowDrop)
    window.removeEventListener('paste', onPaste)
    if (desktopBridge && clipboardImageSubscription != null) desktopBridge.offClipboardImage(clipboardImageSubscription)
    if (desktopBridge && clipboardTextSubscription != null) desktopBridge.offClipboardText(clipboardTextSubscription)
  })

  return {
    importInputRef,
    importRecovery,
    openImportPicker,
    clipboardCard,
    capturingScreen,
    onImportInputChange,
    dismissClipboardCard,
    acceptClipboardCard,
    onCaptureAndInspectScreen,
    inspectClipboardImage,
    cancelCapture,
  }
}
