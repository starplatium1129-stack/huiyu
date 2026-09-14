<script setup lang="ts">
import { useFluidDialog } from '@/composables/useFluidDialog'
import { popularPortraitSrc } from '@/utils/popularPortraitSource'
import { computed, ref, useId } from 'vue'
import type { PopularCharacter, PopularOutfit } from '@/utils/popularContent'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import CharacterDirectory from '@/components/library/CharacterDirectory.vue'
import CharacterPortrait from '@/components/library/CharacterPortrait.vue'

const props = defineProps<{
  characters: PopularCharacter[]
  selectedCharacterId: string
  selectedOutfitId: string
  search: string
}>()

const emit = defineEmits<{
  'update:search': [value: string]
  select: [character: PopularCharacter]
  'select-outfit': [outfitId: string]
}>()

const browserDialog = ref<HTMLDialogElement | null>(null)
const browserMotion = useFluidDialog(browserDialog)
const dialogTitle = useId()
const searchProxy = computed({ get: () => props.search, set: value => emit('update:search', value) })
const directoryItems = computed(() => props.characters.map(character => ({ id: character.id, name: character.displayName, source: character.franchise, aliases: character.aliases, image: popularPortraitSrc(character.id) })))
function selectFromDirectory(id: string) { const character = props.characters.find(item => item.id === id); if (character) { emit('select', character); browserMotion.close() } }

const selectedCharacter = computed<PopularCharacter | null>(() =>
  props.characters.find(c => c.id === props.selectedCharacterId) ?? null,
)
const selectedOutfit = computed<PopularOutfit | null>(() => {
  const character = selectedCharacter.value
  if (!character) return null
  return character.outfits.find(o => o.id === props.selectedOutfitId) ?? null
})
</script>

<template>
  <div class="popular-picker">
    <button type="button" class="character-browse-trigger" aria-haspopup="dialog" @click="browserMotion.open()">
      <CharacterPortrait :src="selectedCharacter ? popularPortraitSrc(selectedCharacter.id) : undefined" :name="selectedCharacter?.displayName || '角色'" />
      <span><small>当前角色</small><strong>{{ selectedCharacter?.displayName || '选择创作角色' }}</strong><small>{{ selectedCharacter?.franchise || '从作品与肖像中挑选' }}</small></span>
    </button>
    <button type="button" class="character-browse-all" aria-haspopup="dialog" @click="browserMotion.open()"><ArchiveIcon name="search" />浏览全部 {{ characters.length }} 位角色</button>
    <p class="character-browse-hint">按作品挑选 · 肖像速览 · 分页浏览</p>
    <Teleport to="body">
      <dialog ref="browserDialog" class="character-browser-dialog" :aria-labelledby="dialogTitle" @cancel.prevent="browserMotion.close()">
        <header class="character-browser-heading"><div><h2 :id="dialogTitle">挑选这一幕的主角</h2><p>先选作品，再选角色；点击肖像即可带回工作台。</p></div><button type="button" aria-label="关闭角色选择" @click="browserMotion.close()"><ArchiveIcon name="close" /></button></header>
        <CharacterDirectory :items="directoryItems" :selected-id="selectedCharacterId" v-model:search="searchProxy" catalog :page-size="18" @select="selectFromDirectory" />
      </dialog>
    </Teleport>
    <div v-if="selectedCharacter" class="popular-outfits">
      <div class="popular-outfits-head">
        <ArchiveIcon name="wardrobe" class="outfits-head-icon" />
        <strong>{{ selectedCharacter.displayName }} · {{ selectedCharacter.originalName }}</strong>
        <span class="popular-badge">{{ selectedCharacter.recommendedEngine === 'krea2-turbo-fp8' ? '推荐 Krea 2' : '推荐 MiaoMiao v1.2' }}</span>
        <span class="popular-nolora-badge">无需 LoRA</span>
      </div>
      <div class="outfit-chips" role="group" aria-label="官方服装">
        <button v-for="outfit in selectedCharacter.outfits" :key="outfit.id"
          type="button" class="outfit-chip"
          :class="{ active: selectedOutfit?.id === outfit.id }"
          :aria-pressed="selectedOutfit?.id === outfit.id"
          @click="emit('select-outfit', outfit.id)">
          {{ outfit.name }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.popular-picker { display: grid; gap: var(--s-3); }
.character-browse-trigger { display: flex; align-items: center; gap: var(--s-3); width: 100%; min-width: 0; padding: var(--s-3); text-align: left; border: 1px solid var(--border-soft); border-radius: var(--r-lg); color: var(--text-primary); background: var(--bg-deep); cursor: pointer; }
.character-browse-trigger img { width: 54px; height: 68px; object-fit: cover; object-position: center 20%; border-radius: var(--r-md); }
.character-browse-trigger > span { min-width: 0; display: grid; gap: var(--s-1); overflow-wrap: anywhere; }
.character-browse-trigger strong { font-size: var(--fs-body-sm); line-height: var(--lh-body); }
.character-browse-trigger small, .character-browse-hint { color: var(--text-muted); font-size: var(--fs-label-xs); line-height: var(--lh-body); }
.character-browse-all { display: flex; justify-content: center; align-items: center; gap: var(--s-2); min-height: 44px; padding: var(--s-2); border: 1px solid var(--accent); border-radius: var(--r-md); background: var(--accent-soft); color: var(--accent); font: 600 var(--fs-label) var(--font-sans); cursor: pointer; }
.character-browse-hint { margin: 0; text-align: center; }
.character-browser-dialog { margin: auto; width: min(1000px, calc(100vw - 32px)); height: min(800px, calc(100dvh - 48px)); max-height: calc(100dvh - 32px); padding: var(--s-5); border: 1px solid var(--border-soft); border-radius: var(--r-xl); background: var(--bg-surface); color: var(--text-primary); box-shadow: var(--shadow-lg); }
.character-browser-dialog[open] { display: flex; flex-direction: column; }
.character-browser-dialog::backdrop { background: var(--art-scrim); }
.character-browser-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--s-3); flex-shrink: 0; }
.character-browser-heading h2 { margin: 0; font-size: var(--fs-title-xs); line-height: var(--lh-body); }
.character-browser-heading p { margin: var(--s-1) 0; font-size: var(--fs-label); color: var(--text-muted); line-height: var(--lh-body); }
.character-browser-heading button { display: grid; place-items: center; flex-shrink: 0; width: 40px; height: 40px; border: 1px solid var(--border-soft); border-radius: var(--r-md); background: var(--bg-deep); color: var(--text-primary); cursor: pointer; }
.character-browse-trigger:focus-visible, .character-browse-all:focus-visible, .character-browser-heading button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { .character-browser-dialog[open] { animation: none; } }
@media (max-width: 540px) { .character-browser-dialog { padding: var(--s-3); } }
.popular-outfits {
  border-top: 1px dashed var(--border-soft);
  padding-top: var(--s-2);
}
.popular-outfits-head {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  flex-wrap: wrap;
  margin-bottom: 6px;
  font-size: var(--fs-label-sm);
}
.outfits-head-icon {
  width: 14px;
  height: 14px;
  color: var(--pb-active);
  opacity: 0.9;
}
.popular-badge,
.popular-nolora-badge {
  font-size: var(--fs-mono-xs);
  padding: 2px var(--s-2);
  border-radius: var(--r-pill);
  border: 1px solid var(--border-strong);
}
.popular-badge {
  color: var(--pb-badge-blue);
  border-color: color-mix(in srgb, var(--info) 40%, transparent);
}
.popular-nolora-badge {
  color: var(--pb-badge-green);
  border-color: color-mix(in srgb, var(--success) 40%, transparent);
}
.outfit-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.outfit-chip {
  padding: var(--s-1) var(--s-3);
  border-radius: var(--r-pill);
  border: 1px solid var(--border-strong);
  background: var(--glass-fill);
  color: inherit;
  font-size: var(--fs-label-sm);
  cursor: pointer;
}
.outfit-chip.active {
  border-color: var(--pb-active);
  background: color-mix(in srgb, var(--mood-love) 16%, transparent);
  color: var(--pb-active-text);
}
</style>
