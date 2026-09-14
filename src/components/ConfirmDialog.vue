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
          @keydown.tab.capture="trapTab"
        >
          <span class="confirm-icon" aria-hidden="true">
            <ArchiveIcon :name="state.danger ? 'warning' : 'info'" />
          </span>
          <h2 class="confirm-title">{{ state.title }}</h2>
          <p v-if="state.message" class="confirm-message">{{ state.message }}</p>
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
import { nextTick, onUnmounted, ref, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { resolveConfirm, useConfirmState } from '@/composables/useConfirm'
import { useFluidSurface } from '@/composables/useFluidSurface'

const surface = useFluidSurface('.confirm-panel')

const state = useConfirmState()
const panel = ref<HTMLElement | null>(null)
const cancelBtn = ref<HTMLButtonElement | null>(null)
const confirmBtn = ref<HTMLButtonElement | null>(null)
let restoreFocusTo: HTMLElement | null = null

function cancel() { resolveConfirm(false) }
function ok() { resolveConfirm(true) }

// 破坏性操作默认聚焦取消键，Enter 手滑不会直接执行删除
watch(() => state.value.visible, async (visible) => {
  if (visible) {
    restoreFocusTo = document.activeElement as HTMLElement | null
    await nextTick()
    ;(state.value.danger ? cancelBtn : confirmBtn).value?.focus()
  } else {
    restoreFocusTo?.focus?.()
    restoreFocusTo = null
  }
})

function trapTab(e: KeyboardEvent) {
  const order = [cancelBtn.value, confirmBtn.value].filter(Boolean) as HTMLButtonElement[]
  if (order.length < 2) return
  const first = order[0]
  const last = order[order.length - 1]
  const active = document.activeElement
  if (e.shiftKey && active === first) { e.preventDefault(); last.focus() }
  else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus() }
  else if (!order.includes(active as HTMLButtonElement)) { e.preventDefault(); first.focus() }
}

/**
 * 只拦截 Escape。Enter 一律交给浏览器原生按钮语义：激活**当前焦点**的那个按钮。
 * 原先这里自己 preventDefault() 再 ok()，导致焦点停在「取消」上按 Enter 仍然执行删除，
 * 与「破坏性操作默认聚焦取消键」的设计直接冲突（2026-08-30 UX 审计 P0-1）。
 */
function onKeydown(e: KeyboardEvent) {
  if (!state.value.visible || e.isComposing || e.keyCode === 229) return
  if (e.key === 'Escape') { e.preventDefault(); cancel() }
}
document.addEventListener('keydown', onKeydown)
onUnmounted(() => document.removeEventListener('keydown', onKeydown))
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
