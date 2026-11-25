<script setup lang="ts">
import { nextTick, ref, useId } from 'vue'
import { useFluidDialog } from '@/composables/useFluidDialog'
import CharacterDirectory, { type DirectoryCharacter } from '@/components/library/CharacterDirectory.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'

defineProps<{ title: string; description: string; items: DirectoryCharacter[]; selectedId: string }>()
const emit = defineEmits<{ select: [id: string] }>()
const search = defineModel<string>('search', { default: '' })
const dialog = ref<HTMLDialogElement | null>(null)
const directoryLoaded = ref(false)
const motion = useFluidDialog(dialog)
const titleId = useId()

async function open(source: HTMLElement) {
  directoryLoaded.value = true
  await nextTick()
  if (source.isConnected && source.getClientRects().length) motion.open(source)
}

function select(id: string) {
  motion.close()
  emit('select', id)
}

defineExpose({ open })
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="character-browser-dialog" :aria-labelledby="titleId" @cancel.prevent="motion.close()">
      <header class="character-browser-heading">
        <div>
          <h2 :id="titleId">{{ title }}</h2>
          <p>{{ description }}</p>
          <slot name="notice" />
        </div>
        <button type="button" aria-label="关闭角色选择" @click="motion.close()"><ArchiveIcon name="close" /></button>
      </header>
      <CharacterDirectory v-if="directoryLoaded" v-model:search="search" :items="items" :selected-id="selectedId"
        catalog :page-size="18" @select="select" @dismiss="motion.close()" />
    </dialog>
  </Teleport>
</template>

<style scoped>
@reference "../../assets/css/tailwind.css";
.character-browser-dialog { @apply tw:m-auto; inset:var(--desktop-chrome-height,0px) 0 0; width: min(1040px, calc(100vw - 32px)); height: min(800px, calc(100dvh - var(--desktop-chrome-height,0px) - 48px)); max-height: calc(100dvh - var(--desktop-chrome-height,0px) - 32px); @apply tw:p-s-5; border: 1px solid var(--border-soft); @apply tw:rounded-xl; background: var(--bg-surface); @apply tw:text-primary; box-shadow: var(--shadow-lg); }
/* 滚动职责下放到筛选栏与结果区，弹窗本体不再套一层滚动。 */
.character-browser-dialog[open] { @apply tw:flex tw:flex-col tw:gap-s-3 tw:overflow-hidden; }
.character-browser-dialog::backdrop { background: var(--art-scrim); }
.character-browser-heading { @apply tw:flex tw:items-start tw:justify-between tw:gap-s-3 tw:shrink-0; }
.character-browser-heading h2 { @apply tw:m-0 tw:text-title-xs tw:leading-body; }
.character-browser-heading p { margin: var(--s-1) 0; @apply tw:text-label tw:text-muted tw:leading-body; }
.character-browser-heading > button { @apply tw:grid; place-items: center; @apply tw:shrink-0 tw:w-[40px] tw:h-[40px]; border: 1px solid var(--border-soft); @apply tw:rounded-md; background: var(--bg-deep); @apply tw:text-primary tw:cursor-pointer; }
.character-browser-heading > button:focus-visible { outline: none; box-shadow: var(--focus-shadow); }
@media (max-width: 540px) { .character-browser-dialog { @apply tw:p-s-3; } }
</style>
