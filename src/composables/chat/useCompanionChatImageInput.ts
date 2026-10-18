import { computed, onMounted, onUnmounted, ref, shallowRef, watch, type Ref } from 'vue'
import type { CompanionDesktopBridge } from '@/types/desktop'
import type { CompanionChatImage } from '@/types/companionDrawing'
import { artworkRepository, type ArtworkRepository } from '@/storage/artworkRepository'
import { imageMediaSession } from '@/platform/imageMediaSession'
import { onDesktopRuntime } from '@/platform/desktop/runtime'
import { workspaceMediaAuthority } from '@/platform/desktop/workspaceMediaSource'
import { imageFormat, withImageMime } from '@/utils/imageFormat'
import { imageForInspection } from '@/utils/companionVision'
import { relayChatTurn } from '@/utils/chatRelayReceipt'

interface SelectedImage {
  blob: Blob; name: string; previewUrl: string
  stored?: { image: CompanionChatImage; authority: string; repository: ArtworkRepository; revision: number }
}
interface Options {
  bridge?: CompanionDesktopBridge; activeChar: Ref<string>; visible: Ref<boolean>
  busy: Ref<boolean>; chatReady: Ref<boolean>; inputText: Ref<string>
  writeBlocked?: Ref<boolean>
  persistDraft: (text: string) => void; notice: (message: string) => void; error: (message: string) => void
}
const MAX_BYTES = 15 * 1024 * 1024
const supported = (file: Blob) => ['image/png', 'image/jpeg', 'image/webp'].includes(file.type)

export function useCompanionChatImageInput(options: Options) {
  const selectedImage = shallowRef<SelectedImage | null>(null)
  const imageInputRef = ref<HTMLInputElement>()
  const preparingImage = ref(false)
  let alive = true, revision = 0, clipboardSubscription: number | undefined
  let activeController: AbortController | null = null
  const canSendImage = computed(() => Boolean(options.bridge && selectedImage.value && options.chatReady.value)
    && !options.busy.value && !options.writeBlocked?.value && !preparingImage.value)
  const canGenerateImage = computed(() => Boolean(options.bridge && selectedImage.value) && !options.busy.value && !options.writeBlocked?.value && !preparingImage.value)

  function removeSelectedImage() {
    const image = selectedImage.value
    selectedImage.value = null
    if (image) URL.revokeObjectURL(image.previewUrl)
  }
  function stopSending() {
    revision++
    activeController?.abort(); activeController = null; preparingImage.value = false
  }
  function cancelImageInput() {
    stopSending()
    removeSelectedImage()
  }
  function selectImage(blob: Blob, name = '聊天图片.png') {
    if (!alive || !options.visible.value || preparingImage.value) return
    if (!supported(blob)) { options.error('请选择 PNG、JPG 或 WebP 图片。'); return }
    if (!blob.size || blob.size > MAX_BYTES) { options.error('图片需小于 15 MB，请缩小后重试。'); return }
    removeSelectedImage()
    selectedImage.value = { blob, name: (name.trim() || '聊天图片.png').slice(0, 160), previewUrl: URL.createObjectURL(blob) }
  }
  function pickImage() { if (!preparingImage.value) imageInputRef.value?.click() }
  function onImageInputChange() {
    const input = imageInputRef.value, file = input?.files?.[0]
    if (input) input.value = ''
    if (file) selectImage(file, file.name)
  }
  function onImagePaste(event: ClipboardEvent) {
    const file = Array.from(event.clipboardData?.files || []).find(supported)
    if (!file) return
    event.preventDefault(); event.stopPropagation(); selectImage(file, file.name || '粘贴图片.png')
  }
  function onImageDrop(event: DragEvent) {
    const files = Array.from(event.dataTransfer?.files || [])
    if (!files.length) return
    event.preventDefault(); event.stopPropagation()
    const file = files.find(supported)
    if (!file) { options.error('请选择 PNG、JPG 或 WebP 图片。'); return }
    selectImage(file, file.name)
    if (files.length > 1) options.notice('已选择第一张图片，每次可发送一张。')
  }

  async function persistImage(selected: SelectedImage, repository: ArtworkRepository, authority: string, ownerRevision: number, check: () => void): Promise<CompanionChatImage> {
    check()
    if (selected.stored) {
      if (selected.stored.repository !== repository || selected.stored.authority !== authority || selected.stored.revision !== ownerRevision)
        throw new Error('附件所属连接已变化，原图仍保留；请重新选择图片后发送。')
      return selected.stored.image
    }
    const format = imageFormat(await selected.blob.slice(0, 12).arrayBuffer())
    check()
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(format.mime)) throw new Error('请选择真实的 PNG、JPG 或 WebP 图片。')
    const blob = await withImageMime(selected.blob, format.mime)
    check()
    // Chat owns the original for previews and reverse prompting; sending creates no gallery record.
    const imageId = await repository.putImage(blob)
    check()
    const image = { path: imageId, imageId, name: selected.name }
    selected.stored = { image, authority, repository, revision: ownerRevision }
    return image
  }
  async function sendPendingImage(action?: 'generate-from-image') {
    const selected = selectedImage.value, bridge = options.bridge
    if (!alive || !options.visible.value || !selected || !bridge || options.busy.value || options.writeBlocked?.value || preparingImage.value) return
    if (!action && !options.chatReady.value) { options.error('请先连接支持图片的聊天模型。'); return }
    const ownerRevision = revision, character = options.activeChar.value, repository = artworkRepository, session = imageMediaSession()
    const input = options.inputText.value, text = input.trim() || (action ? '请反推这张图片并生成一张新图' : '请看看这张图片。')
    const controller = new AbortController(); activeController = controller; preparingImage.value = true
    const current = () => alive && !controller.signal.aborted && activeController === controller && revision === ownerRevision
      && options.visible.value && selectedImage.value === selected && options.activeChar.value === character
      && repository === artworkRepository && session === imageMediaSession()
    const check = () => { if (!current()) throw new DOMException('附件准备已停止', 'AbortError') }
    try {
      const authority = workspaceMediaAuthority()
      const image = await persistImage(selected, repository, authority, ownerRevision, check)
      if (!current()) return
      const imageUrl = action ? undefined : await imageForInspection(selected.blob, controller.signal)
      if (!current()) return
      await relayChatTurn(bridge, text, character, imageUrl, controller.signal, { image, imageAuthority: authority, ...(action ? { action } : {}) })
      if (!current()) return
      if (selectedImage.value === selected) removeSelectedImage()
      if (options.inputText.value === input) { options.inputText.value = ''; options.persistDraft('') }
      options.notice(action ? '图片已送给桌宠，正在反推并生成。' : '图片已发送给桌宠。')
    } catch (error) {
      if (current()) options.error(error instanceof Error && error.message !== 'chat turn not accepted'
        ? error.message : '桌宠尚未接收图片，附件已保留。请等当前操作完成后重试。')
    } finally {
      if (activeController === controller) { activeController = null; preparingImage.value = false }
    }
  }
  watch(options.activeChar, cancelImageInput, { flush: 'sync' })
  watch(options.visible, visible => { if (!visible) cancelImageInput() }, { flush: 'sync' })
  let mediaSession = imageMediaSession()
  function refreshSession() {
    const next = imageMediaSession()
    if (next === mediaSession) return
    mediaSession = next
    // Keep the selected Blob, but never revive its upload or cached alias on reconnect.
    stopSending()
  }
  const stopRuntime = onDesktopRuntime(refreshSession)
  watch(imageMediaSession, refreshSession, { flush: 'sync' })
  onMounted(() => {
    if (options.bridge) clipboardSubscription = options.bridge.onClipboardImage(png => {
      if (!png.length || png.length > MAX_BYTES) return
      const data = new Uint8Array(png)
      selectImage(new Blob([data.buffer], { type: 'image/png' }), '剪贴板图片.png')
    })
  })
  onUnmounted(() => {
    alive = false; stopRuntime(); cancelImageInput()
    if (clipboardSubscription !== undefined) options.bridge?.offClipboardImage(clipboardSubscription)
  })
  return { selectedImage, imageInputRef, preparingImage, canSendImage, canGenerateImage,
    pickImage, onImageInputChange, onImagePaste, onImageDrop, cancelImageInput, sendPendingImage }
}
