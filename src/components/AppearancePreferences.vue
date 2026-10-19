<template>
  <button v-if="!hideTriggers" class="appearance-entry" type="button" @click="launch('appearance')"><ArchiveIcon name="palette" />外观与动态效果</button>
  <button v-if="!hideTriggers" class="appearance-entry" type="button" @click="launch('keyboard')"><ArchiveIcon name="gear" />键盘快捷键 <kbd>F1</kbd></button>
  <Teleport v-if="!launcherOnly" to="body">
    <dialog ref="dialog" class="appearance-dialog" aria-labelledby="appearance-title" @close="onClosed" @cancel.prevent="close()" @click="backdropClose">
      <header class="appearance-heading">
        <div><h2 id="appearance-title">{{ section === 'keyboard' ? '键盘快捷键' : '外观与动态效果' }}</h2><p v-if="section === 'appearance'" class="appearance-save-note">自动保存</p></div>
        <button class="btn btn-quiet btn-icon appearance-close" type="button" aria-label="关闭" autofocus @click="close()"><ArchiveIcon name="close" /></button>
      </header>
      <div ref="content" class="appearance-content" :tabindex="section === 'keyboard' ? 0 : -1" role="region" :aria-label="section === 'keyboard' ? '快捷键列表' : '外观设置'" :aria-busy="!!request && !panel && !failed">
        <component :is="panel" v-if="request && panel" :section="section" />
        <div v-else class="appearance-feedback">
          <span class="appearance-feedback-mark" aria-hidden="true"><ArchiveIcon :name="section === 'keyboard' ? 'gear' : 'palette'" /></span>
          <p v-if="failed" role="alert">设置面板{{ retried ? '仍未加载，请检查连接后重新载入应用' : '暂未加载' }}，当前外观设置已保留。</p>
          <p v-else role="status">正在打开{{ section === 'keyboard' ? '键盘快捷键' : '外观设置' }}…</p>
          <button v-if="failed" class="btn btn-ghost btn-sm" type="button" @click="retry">{{ retried ? '重新载入应用' : '重新读取' }}</button>
        </div>
      </div>
    </dialog>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch, type Component, type ShallowRef } from 'vue'
import { useRoute } from 'vue-router'
import ArchiveIcon from './visual/ArchiveIcon.vue'
import { appearanceFocusOrigin, desktopShortcutAllowed } from '@/composables/useDesktopInteraction'
import { isBackdropClick, useFluidDialog } from '@/composables/useFluidDialog'
import '@/assets/css/appearance-preferences.css'
type AppearanceSection = 'appearance' | 'keyboard'
type AppearanceRequest = { section: AppearanceSection; trigger: HTMLElement | null }
type FocusReturn = { trigger: HTMLElement | null; path: string; version: number }
const panel: ShallowRef<Component | null> = shallowRef(null)
let panelDownload: Promise<{ default: Component }> | null = null, disposed = false
const props = withDefaults(defineProps<{ launcherOnly?: boolean; hideTriggers?: boolean }>(), { launcherOnly: false, hideTriggers: false })
const emit = defineEmits<{ open: [] }>()
const request = shallowRef<AppearanceRequest>()
const section = computed(() => request.value?.section ?? 'appearance')
const failed = ref(false), retried = ref(false)
const dialog = ref<HTMLDialogElement | null>(null), content = ref<HTMLElement | null>(null)
const route = useRoute()
let opening = 0
let focusReturn: FocusReturn | null = null
const fluidDialog = useFluidDialog(dialog)
function launch(section: AppearanceSection) {
  window.dispatchEvent(new CustomEvent('atelier:appearance-open', { detail: { section } }))
  emit('open')
}
async function open(section: AppearanceSection, trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null) {
  if (disposed || props.launcherOnly) return
  focusReturn = null
  const version = ++opening, wasOpen = !!dialog.value?.open
  const changingSection = request.value?.section !== section
  const focusInside = !!content.value?.contains(document.activeElement)
  const origin = wasOpen ? request.value?.trigger ?? null : trigger
  // The frame opens independently of its lazy content and retains the first origin.
  request.value = { section, trigger: origin }
  if (!failed.value) void loadPanel()
  await nextTick()
  if (disposed || version !== opening || !request.value) return
  fluidDialog.open(appearanceFocusOrigin(origin))
  // A hidden native dialog retains its previous scroll position until showModal.
  if (changingSection && content.value) content.value.scrollTop = 0
  if (wasOpen && focusInside && document.activeElement === document.body) {
    dialog.value?.querySelector<HTMLButtonElement>('.appearance-close')?.focus({ preventScroll: true })
  }
}
async function loadPanel() {
  if (panel.value || panelDownload || disposed) return
  failed.value = false
  panelDownload = import('./AppearancePreferencesPanel.vue')
  try {
    const loaded = await panelDownload
    // Closing or changing route cancels intent, while a late module may warm the cache.
    if (!disposed) panel.value = loaded.default
  } catch { if (!disposed) failed.value = true }
  finally { panelDownload = null }
}
function retry() {
  if (disposed || !request.value || !failed.value || panelDownload) return
  if (retried.value) { window.location.reload(); return }
  retried.value = true
  content.value?.focus({ preventScroll: true })
  void loadPanel()
}
async function close(restoreFocus = true) {
  const origin = request.value?.trigger
  const path = route.fullPath, version = ++opening
  const ticket = focusReturn = restoreFocus && origin !== undefined ? { trigger: origin, path, version } : null
  request.value = undefined
  fluidDialog.close()
  if (!ticket) return
  await nextTick()
  restoreClosingFocus(ticket)
}
function restoreClosingFocus(ticket = focusReturn) {
  const active = document.activeElement
  const lostFocus = active === document.body || (active instanceof Node && dialog.value?.contains(active))
  // Responsive navigation can replace the trigger. A new opening or route owns focus.
  if (ticket && focusReturn === ticket && !disposed && opening === ticket.version && route.fullPath === ticket.path
    && !request.value && !dialog.value?.open && lostFocus)
    appearanceFocusOrigin(ticket.trigger)?.focus({ preventScroll: true })
}
function onClosed() {
  // Ignore a queued close from the previous opening of this same native dialog.
  if (dialog.value?.open) return
  if (request.value) opening++
  request.value = undefined
  // Native Escape can retain focus inside the closed dialog until after this event.
  restoreClosingFocus()
}
function backdropClose(event: MouseEvent) {
  if (isBackdropClick(event, dialog.value)) close()
}
function keyboardHelp() { void open('keyboard') }
function appearanceOpen(event: Event) { void open((event as CustomEvent).detail?.section === 'keyboard' ? 'keyboard' : 'appearance') }
function keyboard(event: KeyboardEvent) {
  const current = dialog.value
  if (current?.open) {
    if (event.key === 'F1' && !event.ctrlKey && !event.shiftKey && desktopShortcutAllowed(event)
      && event.target instanceof Node && current.contains(event.target)) {
      event.preventDefault(); void open('keyboard')
    }
  } else if (event.key === 'Escape' && desktopShortcutAllowed(event) && request.value) {
    event.preventDefault(); close()
  }
}
watch(() => route.fullPath, () => { if (request.value) close(false) }, { flush: 'sync' })
onMounted(() => {
  if (props.launcherOnly) return
  window.addEventListener('atelier:keyboard-help', keyboardHelp)
  window.addEventListener('atelier:appearance-open', appearanceOpen)
  window.addEventListener('keydown', keyboard, true)
})
onUnmounted(() => {
  disposed = true
  focusReturn = null
  opening++
  if (props.launcherOnly) return
  window.removeEventListener('atelier:keyboard-help', keyboardHelp)
  window.removeEventListener('atelier:appearance-open', appearanceOpen)
  window.removeEventListener('keydown', keyboard, true)
})
</script>

<style>
@reference "../assets/css/tailwind.css";
.appearance-entry { @apply tw:flex tw:items-center tw:gap-s-2; grid-column: 1 / -1; @apply tw:p-s-3; border: 0; @apply tw:rounded-md; background: transparent; @apply tw:text-secondary; font: inherit; @apply tw:text-left tw:cursor-pointer; }
.appearance-entry:hover { background: transparent; @apply tw:text-primary; }
.appearance-entry kbd { margin-inline-start: auto; }
</style>
