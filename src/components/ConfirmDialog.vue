<template>
  <Teleport :to="teleportTarget">
    <!-- Decision feedback and keyboard focus do not wait for decorative motion. -->
      <div
        v-show="state.visible"
        :inert="!state.visible"
        :aria-hidden="!state.visible"
        class="confirm-overlay"
        @pointerdown.self="cancel"
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
              ref="cancelBtn"
              class="btn confirm-btn"
              type="button"
              @click="cancel"
            >{{ state.cancelLabel }}</button>
            <!-- Keep the safe choice first among actions and confirmation last in keyboard order.
                 The alternate close action stays reachable at its visual corner. -->
            <button class="confirm-close" type="button" aria-label="关闭确认框" @click="cancel"><ArchiveIcon name="close" /></button>
            <button
              ref="confirmBtn"
              class="btn confirm-btn"
              :class="state.danger ? 'btn-danger' : 'btn-primary'"
              type="button"
              @click="ok"
            >{{ state.confirmLabel }}</button>
          </div>
        </div>
      </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, shallowRef, useId, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { resolveConfirm, useConfirmState } from '@/composables/useConfirm'
import { useFocusTrap } from '@/composables/useFocusTrap'

const state = useConfirmState()
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

function cancel() { resolveConfirm(false) }
function ok() { resolveConfirm(true) }

// 与下层弹窗共用焦点栈和滚动锁；破坏性操作默认聚焦取消。
useFocusTrap(panel, () => state.value.visible, { onEscape: cancel, initialFocus })

// 新请求可替换仍显示的确认框；每次都重新选择安全默认项。
watch(state, (current) => {
  if (current.visible) initialFocus.value?.focus({ preventScroll: true })
}, { flush: 'post' })

// Enter 交给浏览器激活当前焦点按钮；卸载则安全取消未完成的请求。
onUnmounted(() => {
  cancel()
})
</script>

<style scoped>
@reference "../assets/css/tailwind.css";
.confirm-overlay {
  @apply tw:fixed;
  inset: 0;
  z-index: var(--z-confirm);
  @apply tw:flex tw:items-center tw:justify-center tw:p-s-4;
  background: var(--art-scrim);
  backdrop-filter: blur(6px);
}
.confirm-panel {
  @apply tw:relative tw:flex tw:flex-col;
  width: min(380px, calc(100vw - 32px));
  max-height: calc(100dvh - 2 * var(--s-4));
  overflow: hidden;
  @apply tw:p-s-5;
  border: 1px solid var(--glass-edge);
  @apply tw:text-primary;
}
.confirm-close { @apply tw:absolute tw:top-s-3 tw:right-s-3 tw:grid; place-items:center; @apply tw:w-[40px] tw:h-[40px]; border:1px solid var(--border-soft); @apply tw:rounded-pill; background:var(--bg-base); @apply tw:text-secondary tw:cursor-pointer; }
.confirm-close:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
@media (hover:hover) and (pointer:fine) {
  .confirm-close:hover { background:var(--accent-soft); border-color:var(--accent); color:var(--accent); }
}
.confirm-icon { @apply tw:pr-[44px] tw:min-h-[28px]; }
.confirm-icon { @apply tw:block tw:mb-s-2 tw:text-secondary; }
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
.confirm-message:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.confirm-actions {
  @apply tw:flex tw:flex-wrap tw:justify-end tw:gap-s-2;
}
.confirm-btn { @apply tw:min-w-[96px]; max-width:100%; white-space:normal; overflow-wrap:anywhere; }
</style>
