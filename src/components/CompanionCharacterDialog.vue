<script setup lang="ts">
import { computed, onMounted, ref, useId } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import CharacterDirectory from './library/CharacterDirectory.vue'
import ArchiveIcon from './visual/ArchiveIcon.vue'
import { isBackdropClick, useFluidDialog } from '@/composables/useFluidDialog'
import { listCompanionUiCharacters } from '@/utils/companionRegistry'
import { characterArtEntry } from '@/platform/characterArtState'

const props = defineProps<{ opener: HTMLElement; selectedId: string }>()
const emit = defineEmits<{ select: [id: string]; dismiss: [] }>()
const dialog = ref<HTMLDialogElement | null>(null)
const title = useId()
const compact = useMediaQuery('(max-width: 640px)')
const motion = useFluidDialog(dialog)
const items = computed(() => listCompanionUiCharacters().map(character => {
  const image = character.presentation?.image
  const catalogId = character.catalogId || character.id
  // Keep the artwork embedded in an imported PNG ahead of the catalog portrait.
  const thumbnail = image?.startsWith('/api/chat/cards/') ? image : characterArtEntry(catalogId)?.thumbnailUrl
    || image?.replace(/\/characters\/popular-([\w-]+)\.png(?=[?#]|$)/, '/characters/thumbs/popular-$1.webp')
  return { id: character.id, name: character.name, source: character.source || '本地导入',
    aliases: [character.shortName, catalogId, ...(character.aliases || [])], image: thumbnail }
}))
onMounted(() => { motion.open(props.opener) })
function select(id: string) {
  motion.close()
  emit('select', id)
}
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="companion-character-dialog" :aria-labelledby="title"
      @cancel.prevent="motion.close()" @close="emit('dismiss')" @click="isBackdropClick($event, dialog) && motion.close()">
      <header>
        <h2 :id="title">选择聊天角色</h2>
        <span class="character-dialog-actions"><slot name="actions" :close="motion.close" />
          <button class="btn btn-quiet btn-icon" type="button" aria-label="关闭角色选择" @click="motion.close()"><ArchiveIcon name="close" /></button>
        </span>
      </header>
      <CharacterDirectory :items="items" :selected-id="selectedId" catalog :compact-catalog="compact"
        :page-size="12" @select="select" @dismiss="motion.close()" />
    </dialog>
  </Teleport>
</template>

<style scoped>
.companion-character-dialog { box-sizing:border-box; inset:var(--desktop-chrome-height,0px) 0 0; margin:auto; width:min(880px,calc(100% - 24px)); max-width:none; height:min(710px,calc(100dvh - var(--desktop-chrome-height,0px) - 24px)); max-height:none; padding:var(--s-5); border:1px solid var(--border-strong); border-radius:var(--r-xl); background:var(--bg-surface); color:var(--text-primary); box-shadow:var(--shadow-lg); overscroll-behavior:contain; }
.companion-character-dialog[open] { display:flex; flex-direction:column; gap:var(--s-3); overflow:hidden; }
.companion-character-dialog::backdrop { background:var(--art-scrim); overflow:hidden; overscroll-behavior:contain; }
.companion-character-dialog > header,.character-dialog-actions { display:flex; align-items:center; gap:var(--s-2); }
.companion-character-dialog > header { flex:none; justify-content:space-between; }
.companion-character-dialog h2 { margin:0; font-size:var(--fs-title-xs); }
@media (max-width:640px), (max-height:520px) {
  .companion-character-dialog { width:calc(100% - 12px); height:calc(100dvh - var(--desktop-chrome-height,0px) - 12px); padding:var(--s-3); border-radius:var(--r-lg); }
}
@media (max-height:420px) {
  .companion-character-dialog[open] { overflow-y:auto; }
  .companion-character-dialog :deep(.directory-catalog) { flex:none; min-height:320px; }
}
</style>
