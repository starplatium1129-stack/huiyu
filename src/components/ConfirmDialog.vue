<template>
  <StudioDialog
    :open="state.visible"
    size="sm"
    :tone="state.danger ? 'danger' : 'default'"
    close-label="关闭确认框"
    :described-by="state.message ? messageId : undefined"
    borderless-header
    dialog-class="confirm-dialog"
    @update:open="onOpenChange"
    @close="rejectCurrent"
  >
    <template #header="{ titleId }">
      <div class="confirm-header" :class="{ 'is-danger': state.danger }">
        <span class="confirm-icon" aria-hidden="true">
          <ArchiveIcon :name="state.danger ? 'warning' : 'info'" />
        </span>
        <h2 :id="titleId" class="studio-dialog-title confirm-title">{{ state.title }}</h2>
      </div>
    </template>

    <p v-if="state.message" :id="messageId" class="confirm-message">{{ state.message }}</p>

    <template #footer>
      <div class="confirm-actions">
        <button
          :key="`cancel:${state.requestId}`"
          ref="cancelBtn"
          :data-confirm-request="state.requestId"
          class="btn btn-ghost confirm-btn"
          type="button"
          :autofocus="state.danger || undefined"
          @click="cancel"
        >{{ state.cancelLabel }}</button>
        <button
          :key="`confirm:${state.requestId}`"
          ref="confirmBtn"
          :data-confirm-request="state.requestId"
          class="btn confirm-btn"
          :class="state.danger ? 'btn-danger' : 'btn-primary'"
          type="button"
          :autofocus="!state.danger || undefined"
          @click="ok"
          @keydown="onConfirmKeyDown"
          @keyup="onConfirmKeyUp"
          @blur="clearConfirmationKey"
        >{{ state.confirmLabel }}</button>
      </div>
    </template>
  </StudioDialog>
</template>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, useId, watch } from 'vue'
import { useRoute } from 'vue-router'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioDialog from '@/components/ui/StudioDialog.vue'
import { resolveConfirm, useConfirmState } from '@/composables/useConfirm'

const state = useConfirmState()
const route = useRoute()
const cancelBtn = ref<HTMLButtonElement | null>(null)
const confirmBtn = ref<HTMLButtonElement | null>(null)
const messageId = useId()
const initialFocus = computed(() => state.value.danger ? cancelBtn.value : confirmBtn.value)

// Never lend an old button's gesture to a replacement confirmation request.
function requestFromEvent(event: Event) {
  return event.currentTarget instanceof HTMLElement
    ? Number(event.currentTarget.dataset.confirmRequest) : NaN
}
function cancel(event: Event) { resolveConfirm(requestFromEvent(event), false) }
function ok(event: Event) { resolveConfirm(requestFromEvent(event), true) }
function rejectCurrent() { resolveConfirm(state.value.requestId, false) }
function onOpenChange(next: boolean) {
  if (!next) rejectCurrent()
}

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

// Only a committed page change cancels intent; leave guards keep their own confirmation.
watch(() => route.path, rejectCurrent, { flush: 'sync' })

// Focus the safe default action whenever a request opens or replaces an active confirmation.
watch([() => state.value.visible, () => state.value.requestId], async ([visible]) => {
  if (!visible) return
  await nextTick()
  initialFocus.value?.focus({ preventScroll: true })
}, { flush: 'post' })

onUnmounted(rejectCurrent)
</script>

<style scoped>
.confirm-header {
  display: flex;
  align-items: flex-start;
  gap: var(--s-2);
  min-width: 0;
}

.confirm-icon {
  display: grid;
  place-items: center;
  flex: none;
  width: 28px;
  height: 28px;
  border-radius: var(--r-sm);
  background: var(--accent-soft);
  color: var(--accent);
}

.confirm-icon > .archive-icon {
  display: block;
  width: 18px;
  height: 18px;
}

.confirm-header.is-danger .confirm-icon {
  background: color-mix(in srgb, var(--danger) 12%, var(--bg-surface));
  color: var(--danger-text);
}

.confirm-title {
  padding-top: 2px;
}

.confirm-message {
  margin: 0;
  overflow-wrap: anywhere;
  white-space: pre-line;
  color: var(--text-secondary);
  font-size: var(--fs-body-sm);
  line-height: var(--lh-body);
}

.confirm-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--s-2);
  width: 100%;
}

.confirm-btn {
  min-width: 96px;
  max-width: 100%;
  white-space: normal;
  overflow-wrap: anywhere;
}
</style>
