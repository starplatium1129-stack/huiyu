<template>
  <div ref="actionsMoreRef" class="chat-actions-more" @focusout="onRoomActionFocusout">
    <button class="btn btn-ghost chat-more-trigger" type="button"
      :aria-expanded="moreOpen ? 'true' : 'false'" aria-haspopup="menu"
      @keydown.down.prevent="focusRoomAction(0)" @keydown.up.prevent="focusRoomAction(-1)"
      @click="moreOpen = !moreOpen">更多<span class="chat-more-caret" aria-hidden="true">{{ moreOpen ? '▴' : '▾' }}</span></button>
    <FluidTransition>
      <div v-if="moreOpen" class="chat-more-menu" role="menu" aria-label="更多房间操作" @keydown="navigateRoomActions">
        <button class="chat-more-item is-danger" role="menuitem" type="button"
          @click="runRoomAction(() => emit('clear-all'))">清空聊天内容与个人档案</button>
        <button class="chat-more-item" role="menuitem" type="button"
          @click="runRoomAction(() => emit('toggle-archive'))">对话归档</button>
        <button class="chat-more-item" role="menuitem" type="button"
          @click="runRoomAction(() => emit('toggle-memory'))">长期记忆</button>
        <button class="chat-more-item" role="menuitem" type="button"
          @click="runRoomAction(() => emit('toggle-profile'))">我的档案</button>
      </div>
    </FluidTransition>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import FluidTransition from '@/components/visual/FluidTransition.vue'

const emit = defineEmits<{
  (e: 'clear-all'): void
  (e: 'toggle-archive'): void
  (e: 'toggle-memory'): void
  (e: 'toggle-profile'): void
}>()

/** 右上角次要操作收进「更多」菜单：外点与 Escape 关闭，选中即收起。 */
const moreOpen = ref(false)
const actionsMoreRef = ref<HTMLElement | null>(null)

function runRoomAction(action: () => void) {
  moreOpen.value = false
  actionsMoreRef.value?.querySelector<HTMLButtonElement>('.chat-more-trigger')?.focus()
  action()
}

function onRoomActionPointerDown(event: PointerEvent) {
  if (actionsMoreRef.value && event.target instanceof Node && !actionsMoreRef.value.contains(event.target)) {
    moreOpen.value = false
  }
}

function onRoomActionKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !moreOpen.value) return
  event.preventDefault()
  moreOpen.value = false
  actionsMoreRef.value?.querySelector<HTMLButtonElement>('.chat-more-trigger')?.focus()
}

function onRoomActionFocusout(event: FocusEvent) {
  if (event.relatedTarget instanceof Node && !actionsMoreRef.value?.contains(event.relatedTarget)) moreOpen.value = false
}

async function focusRoomAction(index: number) {
  moreOpen.value = true
  await nextTick()
  const items = actionsMoreRef.value?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
  if (items?.length) items[(index + items.length) % items.length]?.focus()
}

function navigateRoomActions(event: KeyboardEvent) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const items = [...(actionsMoreRef.value?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') || [])]
  const index = items.indexOf(document.activeElement as HTMLButtonElement)
  void focusRoomAction(event.key === 'Home' ? 0 : event.key === 'End' ? -1 : index + (event.key === 'ArrowDown' ? 1 : -1))
}

watch(moreOpen, open => {
  if (open) {
    document.addEventListener('pointerdown', onRoomActionPointerDown, true)
    document.addEventListener('keydown', onRoomActionKeydown)
  } else {
    document.removeEventListener('pointerdown', onRoomActionPointerDown, true)
    document.removeEventListener('keydown', onRoomActionKeydown)
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onRoomActionPointerDown, true)
  document.removeEventListener('keydown', onRoomActionKeydown)
})
</script>
