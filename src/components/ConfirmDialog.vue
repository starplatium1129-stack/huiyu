<template>
  <Teleport :to="teleportTarget">
    <FluidTransition panel=".confirm-panel">
      <div
        v-show="state.visible"
        :inert="!state.visible"
        class="confirm-overlay"
        @pointerdown.self="rejectCurrent"
      >
        <div
          ref="panel"
          class="confirm-panel"
          :class="{ 'confirm-danger': state.danger }"
          role="alertdialog"
          aria-modal="true"
          :aria-label="state.title"
          :aria-describedby="state.message ? messageId : undefined"
        >
          <span class="confirm-icon" aria-hidden="true">
            <ArchiveIcon :name="state.danger ? 'warning' : 'info'" />
          </span>
          <h2 class="confirm-title">{{ state.title }}</h2>
          <p v-if="state.message" :id="messageId" class="confirm-message" tabindex="0">{{ state.message }}</p>
          <div class="confirm-actions">
            <button
              :key="`cancel:${state.requestId}`"
              :data-confirm-request="state.requestId"
              ref="cancelBtn"
              class="btn confirm-btn"
              type="button"
              @click="cancel"
            >{{ state.cancelLabel }}</button>
            <!-- Keep the safe choice first among actions and confirmation last in keyboard order.
                 The alternate close action stays reachable at its visual corner. -->
            <button :key="`close:${state.requestId}`" :data-confirm-request="state.requestId" class="btn btn-ghost btn-icon confirm-close" type="button" aria-label="关闭确认框" @click="cancel"><ArchiveIcon name="close" /></button>
            <button
              :key="`confirm:${state.requestId}`"
              :data-confirm-request="state.requestId"
              ref="confirmBtn"
              class="btn confirm-btn"
              :class="state.danger ? 'btn-danger' : 'btn-primary'"
              type="button"
              @click="ok"
              @keydown="onConfirmKeyDown"
              @keyup="onConfirmKeyUp"
              @blur="clearConfirmationKey"
            >{{ state.confirmLabel }}</button>
          </div>
        </div>
      </div>
    </FluidTransition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, shallowRef, useId, watch } from 'vue'
import { useRoute } from 'vue-router'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { resolveConfirm, useConfirmState } from '@/composables/useConfirm'
import { useFocusTrap } from '@/composables/useFocusTrap'
import FluidTransition from '@/components/visual/FluidTransition.vue'

const state = useConfirmState()
const route = useRoute()
const teleportTarget = shallowRef<string | HTMLElement>('body')
// A body portal is inert below a native showModal top layer. Capture the
// requesting dialog before its action button becomes disabled or loses focus.
watch(state, current => {
  if (current.visible) teleportTarget.value = document.activeElement?.closest<HTMLDialogElement>('dialog:modal') ?? 'body'
}, { flush: 'sync' })
const panel = ref<HTMLElement | null>(null)
const cancelBtn = ref<HTMLButtonElement | null>(null)
const confirmBtn = ref<HTMLButtonElement | null>(null)
const messageId = useId()
const initialFocus = computed(() => state.value.danger ? cancelBtn.value : confirmBtn.value)

// Keep the focus-trap root stable, but never lend an old button's gesture to its successor.
function requestFromEvent(event: Event) {
  return event.currentTarget instanceof HTMLElement
    ? Number(event.currentTarget.dataset.confirmRequest) : NaN
}
function cancel(event: Event) { resolveConfirm(requestFromEvent(event), false) }
function ok(event: Event) { resolveConfirm(requestFromEvent(event), true) }
function rejectCurrent() { resolveConfirm(state.value.requestId, false) }
let confirmationKey: { requestId: number; key: string } | null = null
function clearConfirmationKey() { confirmationKey = null }
watch(state, clearConfirmationKey, { flush: 'sync' })
function onConfirmKeyDown(event: KeyboardEvent) {
  if (event.key !== 'Enter' && event.key !== ' ') return
  const requestId = requestFromEvent(event)
  if (event.repeat || requestId !== state.value.requestId) { event.preventDefault(); return }
  confirmationKey = { requestId, key: event.key }
}
function onConfirmKeyUp(event: KeyboardEvent) {
  if (event.key !== 'Enter' && event.key !== ' ') return
  // Space clicks on release; a new focused button did not receive the old keydown.
  if (event.key === ' ' && (confirmationKey?.requestId !== requestFromEvent(event)
    || confirmationKey.key !== event.key)) event.preventDefault()
  clearConfirmationKey()
}

// 与下层弹窗共用焦点栈和滚动锁；破坏性操作默认聚焦取消。
const { returnFocus } = useFocusTrap(panel, () => state.value.visible, { onEscape: rejectCurrent, initialFocus })
// Only a committed page change cancels intent; leave guards keep their own confirmation.
watch(() => route.path, () => { returnFocus.value = null; rejectCurrent() }, { flush: 'sync' })

// 新请求可替换仍显示的确认框；每次都重新选择安全默认项。
watch(state, (current) => {
  if (current.visible) initialFocus.value?.focus({ preventScroll: true })
}, { flush: 'post' })

// Enter 交给浏览器激活当前焦点按钮；卸载则安全取消未完成的请求。
onUnmounted(rejectCurrent)
</script>

<style scoped>
@reference "../assets/css/tailwind.css";
.confirm-overlay {
  @apply tw:fixed;
  inset: 0;
  z-index: var(--z-confirm);
  @apply tw:flex tw:items-center tw:justify-center tw:p-s-4;
  padding-top:calc(var(--desktop-chrome-height,0px) + var(--s-4));
  background: var(--art-scrim);
  backdrop-filter: blur(6px);
}
.confirm-panel {
  @apply tw:relative tw:flex tw:flex-col;
  width: min(380px, calc(100vw - 32px));
  max-height:calc(100dvh - var(--desktop-chrome-height,0px) - 2 * var(--s-4));
  overflow: hidden;
  @apply tw:p-s-5;
  border: 1px solid var(--glass-edge);
  @apply tw:text-primary;
}
.confirm-close { @apply tw:absolute tw:top-s-3 tw:right-s-3; }
.confirm-icon { @apply tw:block tw:mb-s-2 tw:pr-[44px] tw:min-h-[28px] tw:text-secondary; }
.confirm-icon > .archive-icon { display:block; width:24px; height:24px; }
.confirm-icon, .confirm-title, .confirm-actions { flex-shrink:0; }
.confirm-danger .confirm-icon { @apply tw:text-danger-text; }
.confirm-title {
  margin: 0 0 var(--s-2);
  overflow-wrap: anywhere;
  font-size: var(--fs-body-lg, var(--fs-body));
  @apply tw:font-bold tw:text-primary;
}
.confirm-message {
  margin: 0 0 var(--s-3);
  overflow-wrap: anywhere;
  white-space: pre-line;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  font-size: var(--fs-body-sm, var(--fs-body));
  @apply tw:text-secondary tw:leading-body;
}
.confirm-message:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
.confirm-actions {
  @apply tw:flex tw:flex-wrap tw:justify-end tw:gap-s-2;
}
.confirm-btn { @apply tw:min-w-[96px]; max-width:100%; white-space:normal; overflow-wrap:anywhere; }
</style>
