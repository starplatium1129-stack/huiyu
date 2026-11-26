import { nextTick, provide, ref, watch, type Ref } from 'vue'
import { useResizeObserver } from '@vueuse/core'
import { isBackdropClick, useFluidDialog } from '@/composables/useFluidDialog'
import type { ChatUserProfile } from '@/utils/chatUserProfile'
import { chatRoomDismissGuardKey, type ChatRoomDismissGuard } from './useChatRoomDismissGuard'

export type RoomPanel = 'archive' | 'memory' | 'profile' | 'rp' | 'sprites' | 'cards' | 'lorebooks' | 'settings'

// The local boundary mounts portal controls in the visible dialog and owns import recovery.
export const loadChatModelControls = () => import('@/components/ChatModelControls.vue')
export const loadChatApiSettings = () => import('@/components/ChatApiSettings.vue')
export const loadSpeechInputSettings = () => import('@/components/SpeechInputSettings.vue')
export const loadSpeechPopover = () => import('@/components/ui/StudioPopover.vue')

// These panels mount only after a menu action; load their component CSS then too.
export const roomToolLoaders = {
  archive: () => import('@/components/ChatArchivePanel.vue'),
  profile: () => import('@/components/ChatUserProfilePanel.vue'),
  memory: () => import('@/components/ChatMemoryPanel.vue'),
  cards: () => import('@/components/ChatCardManagerPanel.vue'),
  lorebooks: () => import('@/components/ChatLorebookPanel.vue'),
  rp: () => import('@/components/ChatRpPanel.vue'),
  sprites: () => import('@/components/ChatCardSpritesPanel.vue'),
}

export const roomPanelLabels: Record<RoomPanel, string> = {
  archive: '对话归档',
  memory: '记忆与前情摘要',
  profile: '我的马甲与档案',
  rp: 'RP 预设与参数',
  sprites: '情绪差分立绘',
  cards: '角色卡工作台',
  lorebooks: '世界书与知识库',
  settings: '聊天设置',
}

export interface UseChatRoomPanelsOptions {
  apiSettingsOpen: Ref<boolean>
  cardImportPending: Readonly<Ref<boolean>>
  updateUserProfile: (profile: ChatUserProfile) => Promise<boolean>
}

/** Owns room tool dialog lifecycle, resize-aware speech popover focus, and panel routing. */
export function useChatRoomPanels(options: UseChatRoomPanelsOptions) {
  const { apiSettingsOpen, cardImportPending, updateUserProfile } = options
  let speechOpenRef: Ref<boolean> | null = null

  const roomPanel = ref<RoomPanel | null>(null)
  const roomPanelGeneration = ref(0)
  let roomPanelClosing = false
  let dismissGuard: ChatRoomDismissGuard | undefined
  let confirmingDismiss = false
  provide(chatRoomDismissGuardKey, guard => {
    dismissGuard = guard
    return () => { if (dismissGuard === guard) dismissGuard = undefined }
  })
  const roomPanelDialog = ref<HTMLDialogElement | null>(null)
  const roomPanelMotion = useFluidDialog(roomPanelDialog)

  useResizeObserver(roomPanelDialog, () => {
    if (!speechOpenRef?.value) return
    const dialog = roomPanelDialog.value
    const popover = dialog?.querySelector<HTMLElement>('.chat-speech-settings')
    const trigger = dialog?.querySelector<HTMLElement>('.room-settings-voice [aria-haspopup="dialog"]')
    const body = trigger?.closest<HTMLElement>('.room-tool-body')
    if (!trigger || !body || (document.activeElement !== document.body && !popover?.contains(document.activeElement))) return
    const bounds = body.getBoundingClientRect(), anchor = trigger.getBoundingClientRect()
    if (anchor.top >= bounds.top && anchor.bottom <= bounds.bottom) return
    // Keep the draft mounted when a smaller viewport clips Reka's anchor.
    trigger.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
    trigger.focus({ preventScroll: true })
  }, { box: 'border-box' })

  async function focusRoomPanel() {
    const generation = roomPanelGeneration.value
    await nextTick()
    const dialog = roomPanelDialog.value, active = document.activeElement
    if (!dialog?.open || roomPanelClosing || !roomPanel.value || generation !== roomPanelGeneration.value) return
    // Loading removes its close button on resolve; preserve focus already moved into the ready panel or a nested portal.
    if (active && active !== document.body && active !== dialog && active !== dialog.querySelector('.room-panel-content > .async-panel')) return
    dialog.querySelector<HTMLElement>('.room-panel-content button')?.focus({ preventScroll: true })
  }

  async function openRoomPanel(panel: RoomPanel) {
    roomPanelClosing = false
    const generation = ++roomPanelGeneration.value
    roomPanel.value = panel
    await nextTick()
    if (roomPanelClosing || roomPanel.value !== panel || generation !== roomPanelGeneration.value) return
    roomPanelMotion.open(document.querySelector<HTMLElement>(panel === 'settings' ? '.chat-settings-trigger' : panel === 'rp' ? '.room-rp-trigger' : '.chat-more-trigger'))
    void focusRoomPanel()
  }

  function clearRoomPanel() {
    roomPanel.value = null
    apiSettingsOpen.value = false
    if (speechOpenRef) speechOpenRef.value = false
  }

  async function closeRoomPanel() {
    if (roomPanelClosing || confirmingDismiss) return
    if (dismissGuard) {
      const generation = roomPanelGeneration.value
      confirmingDismiss = true
      try {
        if (!await dismissGuard() || generation !== roomPanelGeneration.value) return
      } finally {
        confirmingDismiss = false
      }
    }
    roomPanelClosing = true
    if (speechOpenRef) speechOpenRef.value = false
    roomPanelMotion.close(clearRoomPanel)
  }

  function onRoomPanelClosed() {
    if (!roomPanelDialog.value?.open) clearRoomPanel()
  }

  function closeRoomPanelFromBackdrop(event: MouseEvent) {
    if (isBackdropClick(event, roomPanelDialog.value)) void closeRoomPanel()
  }

  async function onUserProfileSave(profile: ChatUserProfile): Promise<boolean> {
    const generation = roomPanelGeneration.value
    return await updateUserProfile(profile) && generation === roomPanelGeneration.value && !roomPanelClosing && roomPanel.value === 'profile'
  }

  watch(cardImportPending, importing => {
    if (importing && roomPanel.value === 'settings') void closeRoomPanel()
  })

  function bindSpeechSettingsOpen(speechRef: Ref<boolean>) {
    speechOpenRef = speechRef
    watch([apiSettingsOpen, speechRef], ([api, speech]) => {
      if ((api || speech) && !roomPanelClosing && roomPanel.value !== 'settings') void openRoomPanel('settings')
    }, { immediate: true })
  }

  async function focusSpeechPopover(event: Event) {
    event.preventDefault()
    const opener = document.activeElement
    await nextTick()
    const panel = document.querySelector<HTMLElement>('.chat-speech-settings')
    if (!speechOpenRef?.value || !panel || (document.activeElement !== opener && !panel.contains(document.activeElement))) return
    ;(panel.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled)') || panel).focus({ preventScroll: true })
  }

  function returnSpeechFocus(event: Event) {
    const dialog = roomPanelDialog.value, active = document.activeElement
    if (!dialog?.open || (active !== document.body && !active?.closest('.chat-speech-settings'))) return
    const trigger = dialog.querySelector<HTMLElement>('.room-settings-voice [aria-haspopup="dialog"]')
    if (trigger) { event.preventDefault(); trigger.focus({ preventScroll: true }) }
  }

  function focusSpeechSettings() {
    const panel = document.querySelector<HTMLElement>('.chat-speech-settings')
    // An uncached editor arrives after Reka focuses the empty popover. Preserve
    // any focus the user has moved elsewhere while it was loading.
    if (speechOpenRef?.value && (panel === document.activeElement || panel?.querySelector(':scope > .async-panel') === document.activeElement))
      panel?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled)')?.focus({ preventScroll: true })
  }

  return {
    roomPanel,
    roomPanelGeneration,
    roomPanelLabels,
    roomPanelDialog,
    focusRoomPanel,
    openRoomPanel,
    closeRoomPanel,
    onRoomPanelClosed,
    closeRoomPanelFromBackdrop,
    onUserProfileSave,
    focusSpeechPopover,
    returnSpeechFocus,
    focusSpeechSettings,
    bindSpeechSettingsOpen,
  }
}
