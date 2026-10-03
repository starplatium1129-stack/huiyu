<template>
  <div class="browsing-directory tw:sticky tw:min-w-0">
    <button v-if="narrow" ref="trigger" type="button" class="directory-pocket" aria-haspopup="dialog"
      :aria-label="'选择角色，当前' + (selected?.name || '未选择')" @click="openDirectory">
      <CharacterPortrait :src="resolveRuntimeUrl(selected?.image)" :name="selected?.name || '角色'" />
      <span class="pocket-copy tw:grid tw:gap-s-1 tw:min-w-0"><small>当前主角</small><strong>{{ selected?.name || '选择角色' }}</strong></span>
      <span class="pocket-action tw:ml-auto tw:flex tw:gap-s-2 tw:items-center tw:shrink-0 tw:text-accent">换一位<ArchiveIcon name="search" /></span>
    </button>
    <!-- One directory keeps search, franchise and selection when the window changes size. -->
    <Teleport v-if="dialogHost" :to="dialogHost" :disabled="!narrow">
      <CharacterDirectory :items="items" :selected-id="selectedId" v-model:search="search"
        :catalog="narrow" :page-size="narrow ? 18 : 0" @select="choose" @dismiss="motion.close()" />
    </Teleport>
    <Teleport to="body">
      <dialog ref="dialog" class="directory-sheet tw:m-auto tw:p-s-5 tw:rounded-xl tw:text-primary tw:overflow-hidden" :aria-labelledby="headingId" @cancel.prevent="motion.close()"
        @click="isBackdropClick($event, dialog) && motion.close()">
        <header class="directory-sheet-heading tw:flex tw:justify-between tw:gap-s-3 tw:shrink-0"><div><h2 :id="headingId">翻开角色画集</h2><p>按作品寻找，或输入她的名字。</p></div><button type="button" aria-label="关闭角色画集" @click="motion.close()"><ArchiveIcon name="close" /></button></header>
        <div ref="dialogHost" class="directory-sheet-content tw:flex tw:min-h-0 tw:overflow-hidden"></div>
      </dialog>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { resolveRuntimeUrl } from '@/platform/runtimeUrl'

import { computed, nextTick, onMounted, onUnmounted, ref, useId } from 'vue'
import CharacterDirectory, { type DirectoryCharacter } from './CharacterDirectory.vue'
import CharacterPortrait from './CharacterPortrait.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { isBackdropClick, useFluidDialog } from '@/composables/useFluidDialog'

const props = defineProps<{ items: DirectoryCharacter[]; selectedId: string }>()
const emit = defineEmits<{ select: [id: string] }>()
const media = window.matchMedia('(max-width: 900px)')
const narrow = ref(media.matches)
const selected = computed(() => props.items.find(item => item.id === props.selectedId))
const search = ref('')
const trigger = ref<HTMLButtonElement | null>(null)
const dialog = ref<HTMLDialogElement | null>(null)
const dialogHost = ref<HTMLDivElement | null>(null)
const headingId = useId()
const motion = useFluidDialog(dialog)
function openDirectory() {
  motion.open(trigger.value)
  void nextTick(() => {
    dialog.value?.querySelector('input')?.focus({ preventScroll: true })
    dialog.value?.querySelector('.directory-item[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest' })
  })
}
function choose(id: string) {
  if (narrow.value) motion.close(() => emit('select', id))
  else emit('select', id)
}
function resizeDirectory() {
  // Release native modality before moving its content back into the desktop rail.
  motion.dispose()
  narrow.value = media.matches
}
onMounted(() => media.addEventListener('change', resizeDirectory))
onUnmounted(() => media.removeEventListener('change', resizeDirectory))
</script>

<style scoped>
@reference "../../assets/css/tailwind.css";
.browsing-directory :deep(.character-directory) { @apply tw:static; }
.browsing-directory { top:calc(var(--app-navigation-height,68px) + var(--s-3)); }
.directory-pocket { @apply tw:flex tw:items-center tw:gap-s-3 tw:w-full tw:min-h-[68px]; padding:var(--s-2) var(--s-3); border:1px solid var(--border-soft); @apply tw:rounded-md; background:var(--bg-surface); @apply tw:text-primary tw:text-left tw:cursor-pointer; }
.directory-pocket :deep(.character-portrait) { width:36px; height:48px; border:0; background:var(--art-stage); }
.directory-pocket :deep(.character-portrait img) { object-fit:contain; object-position:center; }
.pocket-copy small { @apply tw:text-secondary tw:text-label-xs; }
.pocket-copy strong { font:600 var(--fs-body)/var(--lh-label) var(--font-sans); overflow-wrap:anywhere; }
.pocket-action { font:500 var(--fs-body-sm) var(--font-sans); }
.directory-sheet { width:min(960px,calc(100vw - 32px)); height:min(780px,calc(100dvh - 32px)); max-width:none; max-height:none; border:1px solid var(--border-strong); background:var(--bg-surface); box-shadow:var(--shadow-lg); }
.directory-sheet[open] { @apply tw:flex tw:flex-col tw:gap-s-3; }
.directory-sheet::backdrop { background:var(--art-backdrop); }
.directory-sheet-heading { align-items:start; }
.directory-sheet-heading h2 { margin:0 0 var(--s-1); font:500 var(--fs-title-sm)/var(--lh-label) var(--font-serif); }
.directory-sheet-heading p { @apply tw:m-0 tw:text-secondary tw:text-body-sm; }
.directory-sheet-heading button { @apply tw:grid; place-items:center; @apply tw:w-[44px] tw:h-[44px] tw:shrink-0; border:1px solid var(--border-soft); @apply tw:rounded-md; background:var(--bg-base); @apply tw:text-primary tw:cursor-pointer; }
.directory-sheet-content { flex:1; }
.directory-sheet-content :deep(.character-directory) { @apply tw:w-full; }
.directory-pocket:focus-visible, .directory-sheet-heading button:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
@media (max-width:900px) { .browsing-directory { @apply tw:static; } }
@media (max-width:540px) { .directory-sheet { @apply tw:p-s-3; } }
</style>
