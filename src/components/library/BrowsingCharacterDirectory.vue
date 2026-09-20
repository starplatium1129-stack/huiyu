<template>
  <div class="browsing-directory">
    <button v-if="narrow" ref="trigger" type="button" class="directory-pocket" aria-haspopup="dialog"
      :aria-label="'选择角色，当前' + (selected?.name || '未选择')" @click="openDirectory">
      <CharacterPortrait :src="selected?.image" :name="selected?.name || '角色'" />
      <span class="pocket-copy"><small>这一页的主角</small><strong>{{ selected?.name || '选择角色' }}</strong></span>
      <span class="pocket-action">换一位<ArchiveIcon name="search" /></span>
    </button>
    <!-- One directory keeps search, franchise and selection when the window changes size. -->
    <Teleport v-if="dialogHost" :to="dialogHost" :disabled="!narrow">
      <CharacterDirectory :items="items" :selected-id="selectedId" v-model:search="search"
        :catalog="narrow" :page-size="narrow ? 18 : 0" @select="choose" @dismiss="motion.close()" />
    </Teleport>
    <Teleport to="body">
      <dialog ref="dialog" class="directory-sheet" :aria-labelledby="headingId" @cancel.prevent="motion.close()"
        @click="isBackdropClick($event, dialog) && motion.close()">
        <header class="directory-sheet-heading"><div><h2 :id="headingId">翻开角色画集</h2><p>按作品寻找，或输入她的名字。</p></div><button type="button" aria-label="关闭角色画集" @click="motion.close()"><ArchiveIcon name="close" /></button></header>
        <div ref="dialogHost" class="directory-sheet-content"></div>
      </dialog>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
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
.browsing-directory { position:sticky; top:82px; min-width:0; }
.browsing-directory :deep(.character-directory) { position:static; }
.directory-pocket { display:flex; align-items:center; gap:var(--s-3); width:100%; min-height:80px; padding:var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--bg-surface); color:var(--text-primary); text-align:left; cursor:pointer; }
.pocket-copy { display:grid; gap:var(--s-1); min-width:0; }
.pocket-copy small { color:var(--text-secondary); font-size:var(--fs-body-sm); }
.pocket-copy strong { font:600 var(--fs-body)/var(--lh-label) var(--font-sans); overflow-wrap:anywhere; }
.pocket-action { margin-left:auto; display:flex; gap:var(--s-2); align-items:center; flex-shrink:0; color:var(--accent); font:500 var(--fs-body-sm) var(--font-sans); }
.directory-sheet { width:min(960px,calc(100vw - 32px)); height:min(780px,calc(100dvh - 32px)); max-width:none; max-height:none; margin:auto; padding:var(--s-5); border:1px solid var(--border-strong); border-radius:var(--r-xl); color:var(--text-primary); background:var(--bg-surface); box-shadow:var(--shadow-lg); overflow:hidden; }
.directory-sheet[open] { display:flex; flex-direction:column; gap:var(--s-3); }
.directory-sheet::backdrop { background:var(--art-backdrop); }
.directory-sheet-heading { display:flex; align-items:start; justify-content:space-between; gap:var(--s-3); flex-shrink:0; }
.directory-sheet-heading h2 { margin:0 0 var(--s-1); font:500 var(--fs-title-sm)/var(--lh-label) var(--font-serif); }
.directory-sheet-heading p { margin:0; color:var(--text-secondary); font-size:var(--fs-body-sm); }
.directory-sheet-heading button { display:grid; place-items:center; width:44px; height:44px; flex-shrink:0; border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--bg-base); color:var(--text-primary); cursor:pointer; }
.directory-sheet-content { display:flex; flex:1; min-height:0; overflow:hidden; }
.directory-sheet-content :deep(.character-directory) { width:100%; }
.directory-pocket:focus-visible, .directory-sheet-heading button:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
@media (max-width:900px) { .browsing-directory { position:static; } }
@media (max-width:540px) { .directory-sheet { padding:var(--s-3); } }
</style>
