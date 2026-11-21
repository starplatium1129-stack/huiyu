<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useId, useSlots, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { useFluidDialog } from '@/composables/useFluidDialog'
import '@/assets/css/components/studio-dialog.css'

/**
 * 共享原生模态弹窗基元：基于原生 <dialog> + showModal() + useFluidDialog。
 * 原生模态已提供顶层堆叠、inert 隔离、焦点环绕与 Esc 关闭，禁止手动叠加
 * role="dialog" / aria-modal / 自定义 focus trap。
 */
const props = withDefaults(defineProps<{
  title?: string
  subtitle?: string
  headingLevel?: 'h2' | 'h3'
  size?: 'sm' | 'md' | 'lg'
  /** 原生 closedby 模式；不支持 closedby 的浏览器由安全 pointerdown+pointerup 降级 */
  closedby?: 'any' | 'closerequest' | 'none'
  showClose?: boolean
  closeLabel?: string
  closeAutofocus?: boolean
  tone?: 'default' | 'danger'
  character?: string
  ariaLabel?: string
  describedBy?: string
  borderlessHeader?: boolean
  dialogClass?: string
  teleport?: boolean
}>(), {
  title: '',
  subtitle: '',
  headingLevel: 'h2',
  size: 'md',
  closedby: 'any',
  showClose: true,
  closeLabel: '关闭对话框',
  closeAutofocus: false,
  tone: 'default',
  character: '',
  ariaLabel: '',
  describedBy: undefined,
  borderlessHeader: false,
  dialogClass: '',
  teleport: true,
})

const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{
  close: [returnValue: string]
  cancel: []
}>()

const slots = useSlots()
const titleId = useId()
const dialogEl = ref<HTMLDialogElement | null>(null)
const fluid = useFluidDialog(dialogEl)

const hasHeader = computed(() => Boolean(slots.header || props.title || props.subtitle || props.showClose))
const labelledBy = computed(() => (slots.header || props.title) ? titleId : undefined)
const accessibleLabel = computed(() => labelledBy.value ? undefined : (props.ariaLabel || props.title || undefined))

const supportsClosedBy = typeof HTMLDialogElement !== 'undefined' && 'closedBy' in HTMLDialogElement.prototype
let pressedOutside = false

function isOutsideDialog(event: PointerEvent, el: HTMLDialogElement): boolean {
  const rect = el.getBoundingClientRect()
  return (
    event.clientX < rect.left
    || event.clientX > rect.right
    || event.clientY < rect.top
    || event.clientY > rect.bottom
  )
}

function openDialog(source?: HTMLElement | null) {
  if (!open.value) open.value = true
  void nextTick(() => {
    if (open.value && dialogEl.value && !dialogEl.value.open) {
      fluid.open(source)
    }
  })
}

function closeDialog(returnValue = '') {
  const el = dialogEl.value
  if (el?.open) {
    el.returnValue = returnValue
    fluid.close()
  } else {
    fluid.close()
  }
  if (open.value) open.value = false
}

function onNativeCancel(event: Event) {
  if (props.closedby === 'none') {
    event.preventDefault()
    emit('cancel')
    return
  }
  // Intercept once to play the reversible fluid exit; if a repeated Esc bypasses
  // preventDefault(), onNativeClose still synchronizes state and resets returnValue.
  event.preventDefault()
  emit('cancel')
  closeDialog('')
}

function onNativeClose() {
  const el = dialogEl.value
  if (!el || el.open) return
  const returnValue = el.returnValue
  el.returnValue = ''
  pressedOutside = false
  if (open.value) open.value = false
  emit('close', returnValue)
}

function onPointerDown(event: PointerEvent) {
  if (supportsClosedBy || props.closedby !== 'any' || !dialogEl.value?.open) {
    pressedOutside = false
    return
  }
  pressedOutside = isOutsideDialog(event, dialogEl.value)
}

function onPointerUp(event: PointerEvent) {
  if (supportsClosedBy || props.closedby !== 'any' || !dialogEl.value?.open) return
  const wasOutside = pressedOutside
  pressedOutside = false
  if (wasOutside && isOutsideDialog(event, dialogEl.value)) {
    emit('cancel')
    closeDialog('')
  }
}

function onPointerCancel() {
  pressedOutside = false
}

watch(open, async value => {
  if (value) {
    await nextTick()
    if (open.value && dialogEl.value && !dialogEl.value.open) {
      fluid.open()
    }
  } else if (dialogEl.value?.open) {
    fluid.close()
  }
}, { flush: 'post' })

onMounted(() => {
  if (open.value && dialogEl.value && !dialogEl.value.open) {
    fluid.open()
  }
})

defineExpose({
  dialogEl,
  openDialog,
  closeDialog,
})
</script>

<template>
  <Teleport to="body" :disabled="!teleport">
    <dialog
      ref="dialogEl"
      class="studio-dialog"
      :class="dialogClass"
      data-elevation="2"
      :data-size="size"
      :data-tone="tone"
      :data-character="character || undefined"
      :closedby="closedby"
      :aria-labelledby="labelledBy"
      :aria-label="accessibleLabel"
      :aria-describedby="describedBy"
      @cancel.stop="onNativeCancel"
      @close="onNativeClose"
      @pointerdown="onPointerDown"
      @pointerup="onPointerUp"
      @pointercancel="onPointerCancel"
    >
      <header v-if="hasHeader" class="studio-dialog-header" :class="{ 'is-borderless': borderlessHeader }">
        <div class="studio-dialog-heading">
          <slot name="header" :title-id="titleId" :close="closeDialog">
            <component :is="headingLevel" v-if="title" :id="titleId" class="studio-dialog-title">{{ title }}</component>
            <p v-if="subtitle" class="studio-dialog-subtitle">{{ subtitle }}</p>
          </slot>
        </div>
        <button
          v-if="showClose"
          class="btn btn-quiet btn-icon studio-dialog-close"
          type="button"
          :aria-label="closeLabel"
          :autofocus="closeAutofocus || undefined"
          @click="closeDialog('')"
        >
          <ArchiveIcon name="close" />
        </button>
      </header>

      <div class="studio-dialog-body">
        <slot :close="closeDialog" />
      </div>

      <footer v-if="$slots.footer" class="studio-dialog-footer">
        <slot name="footer" :close="closeDialog" />
      </footer>
    </dialog>
  </Teleport>
</template>
