<script setup lang="ts">
import { useFluidDialog } from '@/composables/useFluidDialog'
import { popularPortraitSrc } from '@/utils/popularPortraitSource'
import { computed, ref, useId } from 'vue'
import type { PopularCharacter, PopularOutfit } from '@/utils/popularContent'
import { franchiseKey, franchiseLabel } from '@/utils/franchiseLabel'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import CharacterDirectory from '@/components/library/CharacterDirectory.vue'
import CharacterPortrait from '@/components/library/CharacterPortrait.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'

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
/** 作品展示名与角色弹窗组同一口径（中文优先）；无中文字段时回退原文，不编造翻译。 */
const sourceLabel = computed(() => {
  const franchise = String(selectedCharacter.value?.franchise || '').trim()
  if (!franchise) return '从作品与肖像中挑选'
  return franchiseLabel(franchiseKey(franchise)) || franchise
})
</script>

<template>
  <div class="popular-picker">
    <!-- 当前角色：状态与「浏览全部」同处一个按钮，只保留一层稳定底色 + 一个强调动作，
         不再让卡片和浏览按钮各自成框、各自打开同一个弹窗。 -->
    <button type="button" class="character-browse-button" aria-haspopup="dialog" @click="browserMotion.open()">
      <span class="character-browse-trigger">
        <CharacterPortrait :src="selectedCharacter ? popularPortraitSrc(selectedCharacter.id) : undefined" :name="selectedCharacter?.displayName || '角色'" />
        <span class="character-current-text">
          <small class="character-current-kicker">这一幕的主角</small>
          <strong>{{ selectedCharacter?.displayName || '选择创作角色' }}</strong>
          <StudioTooltip :content="sourceLabel">
            <small>{{ sourceLabel }}</small>
          </StudioTooltip>
        </span>
      </span>
      <span class="character-browse-all"><ArchiveIcon name="search" />浏览全部 {{ characters.length }} 位角色</span>
    </button>
    <Teleport to="body">
      <dialog ref="browserDialog" class="character-browser-dialog" :aria-labelledby="dialogTitle" @cancel.prevent="browserMotion.close()">
        <header class="character-browser-heading"><div><h2 :id="dialogTitle">挑选这一幕的主角</h2><p>先按作品缩小范围，再点击肖像即可带回工作台。</p></div><button type="button" aria-label="关闭角色选择" @click="browserMotion.close()"><ArchiveIcon name="close" /></button></header>
        <CharacterDirectory :items="directoryItems" :selected-id="selectedCharacterId" v-model:search="searchProxy" catalog :page-size="18" @select="selectFromDirectory" @dismiss="browserMotion.close()" />
      </dialog>
    </Teleport>
    <div v-if="selectedCharacter" class="popular-outfits">
      <div class="popular-outfits-head">
        <ArchiveIcon name="wardrobe" class="outfits-head-icon" />
        <strong>造型手帖</strong>
        <span class="outfits-count">{{ selectedCharacter.outfits.length }} 套官方服装</span>
      </div>
      <div class="outfit-chips" role="group" aria-label="官方服装">
        <button v-for="outfit in selectedCharacter.outfits" :key="outfit.id"
          type="button" class="outfit-chip"
          :class="{ active: selectedOutfit?.id === outfit.id }"
          :aria-pressed="selectedOutfit?.id === outfit.id"
          @click="emit('select-outfit', outfit.id)">
          <ArchiveIcon :name="selectedOutfit?.id === outfit.id ? 'success' : 'wardrobe'" aria-hidden="true" />
          <span>{{ outfit.name }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.popular-picker { display: grid; gap: var(--s-4); }

/* 当前角色按钮：整体一个点击目标，内部只有「稳定阅读底色」与「强调动作」两层。 */
.character-browse-button {
  display: grid;
  gap: 0;
  width: 100%;
  min-width: 0;
  padding: 0;
  border: 1px solid var(--border-soft);
  border-radius: var(--r-lg);
  overflow: hidden;
  background: var(--bg-surface);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.character-browse-button:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: var(--r-lg); }
.character-browse-trigger {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  min-width: 0;
  padding: var(--s-3);
  background: linear-gradient(135deg, var(--accent-soft), var(--bg-surface) 70%);
  transition: background var(--motion-hover) var(--ease-out);
}
.character-current-text { min-width: 0; display: grid; gap: var(--s-2); overflow-wrap: anywhere; }
.character-current-text strong { color: var(--text-primary); font-size: var(--fs-title-xs); font-weight: 650; line-height: var(--lh-body); }
.character-current-text small { color: var(--text-secondary); font-size: var(--fs-label-xs); line-height: var(--lh-body); }
.character-browse-all {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: var(--s-2);
  min-height: 44px;
  padding: var(--s-2) var(--s-3);
  border-top: 1px solid var(--border-soft);
  background: var(--bg-surface);
  color: var(--accent);
  font: 600 var(--fs-label) var(--font-sans);
  transition: background var(--motion-hover) var(--ease-out), transform var(--motion-hover) var(--ease-out);
}
.character-browse-button:hover .character-portrait { transform: rotate(0deg) translateY(-2px); }
.character-browse-button:hover .character-browse-all { background: var(--bg-hover); }
.character-browse-button:active .character-browse-all { transform: scale(.98); }

.character-browser-dialog { margin: auto; width: min(1040px, calc(100vw - 32px)); height: min(800px, calc(100dvh - 48px)); max-height: calc(100dvh - 32px); padding: var(--s-5); border: 1px solid var(--border-soft); border-radius: var(--r-xl); background: var(--bg-surface); color: var(--text-primary); box-shadow: var(--shadow-lg); }
/* 滚动职责下放到筛选栏与结果区，弹窗本体不再套一层滚动。 */
.character-browser-dialog[open] { display: flex; flex-direction: column; gap: var(--s-3); overflow: hidden; }
.character-browser-dialog::backdrop { background: var(--art-scrim); }
.character-browser-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--s-3); flex-shrink: 0; }
.character-browser-heading h2 { margin: 0; font-size: var(--fs-title-xs); line-height: var(--lh-body); }
.character-browser-heading p { margin: var(--s-1) 0; font-size: var(--fs-label); color: var(--text-muted); line-height: var(--lh-body); }
.character-browser-heading button { display: grid; place-items: center; flex-shrink: 0; width: 40px; height: 40px; border: 1px solid var(--border-soft); border-radius: var(--r-md); background: var(--bg-deep); color: var(--text-primary); cursor: pointer; }
.character-browser-heading button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.popular-outfits { display: grid; gap: var(--s-2); }
.popular-outfits-head {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  flex-wrap: wrap;
  font-size: var(--fs-label-sm);
}
.outfits-head-icon {
  width: 14px;
  height: 14px;
  color: var(--pb-active);
}
.outfits-count { margin-left: auto; color: var(--text-secondary); font-size: var(--fs-label-xs); }
.outfit-chips {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 130px), 1fr));
  gap: var(--s-2);
}
.outfit-chip {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  min-height: 48px;
  min-width: 0;
  padding: var(--s-2) var(--s-3);
  border-radius: var(--r-md);
  text-align: left;
  line-height: var(--lh-body);
  border: 1px solid var(--border-strong);
  background: var(--bg-surface);
  color: var(--text-secondary);
  font-size: var(--fs-label-sm);
  cursor: pointer;
}
.outfit-chip:hover { border-color: var(--accent); color: var(--accent); }
.outfit-chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.outfit-chip.active {
  border-color: var(--accent);
  background: var(--bg-surface);
  color: var(--accent);
  box-shadow: inset 3px 0 var(--accent);
}
@media (prefers-reduced-motion: reduce) {
  .character-browse-button:active .character-browse-all { transform: none; }
  .character-browser-dialog[open] { animation: none; }
}
@media (max-width: 540px) { .character-browser-dialog { padding: var(--s-3); } }
.character-browse-trigger :deep(.character-portrait) { width: 86px; height: 116px; border-radius: var(--r-md); border: 1px solid var(--glass-edge); box-shadow: var(--shadow-sm); transform: rotate(-3deg); transition: transform var(--motion-hover) var(--ease-out); }
.character-current-text .character-current-kicker { color: var(--accent); letter-spacing: .08em; }
.outfit-chip .archive-icon { width: 16px; height: 16px; flex-shrink: 0; }
.outfit-chip span { overflow-wrap: anywhere; }
@media (prefers-reduced-motion: reduce) { .character-browse-trigger :deep(.character-portrait) { transition: none; } .character-browse-button:hover .character-portrait { transform: none; } }
</style>
