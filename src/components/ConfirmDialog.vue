<template>
  <Teleport to="body">
    <Transition :css="false" @enter="surface.enter" @leave="surface.leave" @after-leave="surface.dispose">
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
          <p v-if="state.message" :id="messageId" class="confirm-message">{{ state.message }}</p>
          <div class="confirm-actions">
            <button
              ref="cancelBtn"
              class="btn confirm-btn"
              type="button"
              @click="cancel"
            >{{ state.cancelLabel }}</button>
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
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, useId, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { resolveConfirm, useConfirmState } from '@/composables/useConfirm'
import { useFluidSurface } from '@/composables/useFluidSurface'
import { useFocusTrap } from '@/composables/useFocusTrap'

const surface = useFluidSurface('.confirm-panel')

const state = useConfirmState()
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
.confirm-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-confirm);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--s-4);
  background: var(--art-scrim);
  backdrop-filter: blur(6px);
}
.confirm-panel {
  width: min(380px, calc(100vw - 32px));
  padding: var(--s-5);
  border: 1px solid var(--glass-edge);
  border-radius: var(--r-xl);
  background: var(--bg-surface);
  box-shadow: var(--shadow-glass-elevated);
  color: var(--text-primary);
}
.confirm-icon { display: block; margin-bottom: var(--s-2); color: var(--text-secondary); }
.confirm-danger .confirm-icon { color: var(--danger-text); }
.confirm-title {
  margin: 0 0 var(--s-2);
  font-size: var(--fs-body-lg, var(--fs-body));
  font-weight: 700;
  color: var(--text-primary);
}
.confirm-message {
  margin: 0 0 var(--s-3);
  font-size: var(--fs-body-sm, var(--fs-body));
  color: var(--text-secondary);
  line-height: var(--lh-body);
}
.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--s-2);
}
.confirm-btn { min-width: 96px; }
</style>
