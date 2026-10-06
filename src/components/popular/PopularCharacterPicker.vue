<script setup lang="ts">
import { resolveRuntimeUrl } from '@/platform/runtimeUrl'

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
  <div class="popular-picker tw:grid tw:gap-s-4">
    <!-- 当前角色：状态与「浏览全部」同处一个按钮，只保留一层稳定底色 + 一个强调动作，
         不再让卡片和浏览按钮各自成框、各自打开同一个弹窗。 -->
    <button type="button" class="character-browse-button tw:grid tw:gap-0 tw:w-full tw:min-w-0 tw:p-0 tw:rounded-lg tw:overflow-hidden tw:text-left tw:cursor-pointer" aria-haspopup="dialog" @click="browserMotion.open()">
      <span class="character-browse-trigger tw:flex tw:items-center tw:gap-s-3 tw:min-w-0 tw:p-s-3">
        <CharacterPortrait :src="resolveRuntimeUrl(selectedCharacter ? popularPortraitSrc(selectedCharacter.id) : undefined)" :name="selectedCharacter?.displayName || '角色'" />
        <span v-content-motion:fade="selectedCharacterId" class="character-current-text tw:min-w-0 tw:grid tw:gap-s-2">
          <small class="character-current-kicker">这一幕的主角</small>
          <strong>{{ selectedCharacter?.displayName || '选择创作角色' }}</strong>
          <StudioTooltip :content="sourceLabel">
            <small>{{ sourceLabel }}</small>
          </StudioTooltip>
        </span>
      </span>
      <span class="character-browse-all tw:flex tw:justify-center tw:items-center tw:gap-s-2 tw:min-h-[44px] tw:text-accent"><ArchiveIcon name="search" />浏览全部 {{ characters.length }} 位角色</span>
    </button>
    <Teleport to="body">
      <dialog ref="browserDialog" class="character-browser-dialog" :aria-labelledby="dialogTitle" @cancel.prevent="browserMotion.close()">
        <header class="character-browser-heading"><div><h2 :id="dialogTitle">挑选这一幕的主角</h2><p>先按作品缩小范围，再点击肖像即可带回工作台。</p></div><button type="button" aria-label="关闭角色选择" @click="browserMotion.close()"><ArchiveIcon name="close" /></button></header>
        <CharacterDirectory :items="directoryItems" :selected-id="selectedCharacterId" v-model:search="searchProxy" catalog :page-size="18" @select="selectFromDirectory" @dismiss="browserMotion.close()" />
      </dialog>
    </Teleport>
    <div v-if="selectedCharacter" v-content-motion:fade="selectedCharacterId" class="popular-outfits tw:grid tw:gap-s-2">
      <div class="popular-outfits-head tw:flex tw:items-center tw:gap-s-2 tw:flex-wrap tw:text-label-sm">
        <ArchiveIcon name="wardrobe" class="outfits-head-icon" />
        <strong>造型手帖</strong>
        <span class="outfits-count tw:ml-auto tw:text-secondary tw:text-label-xs">{{ selectedCharacter.outfits.length }} 套官方服装</span>
      </div>
      <div class="outfit-chips tw:grid tw:gap-s-2" role="group" aria-label="官方服装">
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
@reference "../../assets/css/tailwind.css";
/* 当前角色按钮：整体一个点击目标，内部只有「稳定阅读底色」与「强调动作」两层。 */
.character-browse-button {
  border: 1px solid var(--border-soft);
  background: var(--bg-surface);
  color: inherit;
  font: inherit;
}
.character-browse-button:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; @apply tw:rounded-lg; }
.character-browse-trigger {
  background: linear-gradient(135deg, var(--accent-soft), var(--bg-surface) 70%);
  transition: background var(--motion-hover) var(--ease-out);
}
.character-current-text { overflow-wrap: anywhere; }
.character-current-text strong { @apply tw:text-primary tw:text-title-xs; font-weight: 650; @apply tw:leading-body; }
.character-current-text small { @apply tw:text-secondary tw:text-label-xs tw:leading-body; }
.character-browse-all {
  padding: var(--s-2) var(--s-3);
  border-top: 1px solid var(--border-soft);
  background: var(--bg-surface);
  font: 600 var(--fs-label) var(--font-sans);
  transition: background var(--motion-hover) var(--ease-out), transform var(--motion-hover) var(--ease-out);
}
.character-browse-button:hover .character-portrait { transform: rotate(0deg) translateY(-2px); }
.character-browse-button:hover .character-browse-all { background: var(--bg-hover); }
.character-browse-button:active .character-browse-all { transform: scale(.98); }

.character-browser-dialog { @apply tw:m-auto; width: min(1040px, calc(100vw - 32px)); height: min(800px, calc(100dvh - 48px)); max-height: calc(100dvh - 32px); @apply tw:p-s-5; border: 1px solid var(--border-soft); @apply tw:rounded-xl; background: var(--bg-surface); @apply tw:text-primary; box-shadow: var(--shadow-lg); }
/* 滚动职责下放到筛选栏与结果区，弹窗本体不再套一层滚动。 */
.character-browser-dialog[open] { @apply tw:flex tw:flex-col tw:gap-s-3 tw:overflow-hidden; }
.character-browser-dialog::backdrop { background: var(--art-scrim); }
.character-browser-heading { @apply tw:flex tw:items-start tw:justify-between tw:gap-s-3 tw:shrink-0; }
.character-browser-heading h2 { @apply tw:m-0 tw:text-title-xs tw:leading-body; }
.character-browser-heading p { margin: var(--s-1) 0; @apply tw:text-label tw:text-muted tw:leading-body; }
.character-browser-heading button { @apply tw:grid; place-items: center; @apply tw:shrink-0 tw:w-[40px] tw:h-[40px]; border: 1px solid var(--border-soft); @apply tw:rounded-md; background: var(--bg-deep); @apply tw:text-primary tw:cursor-pointer; }
.character-browser-heading button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.outfits-head-icon {
  @apply tw:w-[14px] tw:h-[14px];
  color: var(--pb-active);
}
.outfit-chips {
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 130px), 1fr));
}
.outfit-chip {
  @apply tw:flex tw:items-center tw:gap-s-2 tw:min-h-[48px] tw:min-w-0;
  padding: var(--s-2) var(--s-3);
  @apply tw:rounded-md tw:text-left tw:leading-body;
  border: 1px solid var(--border-strong);
  background: var(--bg-surface);
  @apply tw:text-secondary tw:text-label-sm tw:cursor-pointer;
}
.outfit-chip:hover { @apply tw:border-accent tw:text-accent; }
.outfit-chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.outfit-chip.active {
  @apply tw:border-accent;
  background: var(--bg-surface);
  @apply tw:text-accent;
  box-shadow: inset 3px 0 var(--accent);
}
@media (prefers-reduced-motion: reduce) {
  .character-browse-button:active .character-browse-all { transform: none; }
  .character-browser-dialog[open] { animation: none; }
}
@media (max-width: 540px) { .character-browser-dialog { @apply tw:p-s-3; } }
.character-browse-trigger :deep(.character-portrait) { @apply tw:w-[86px] tw:h-[116px] tw:rounded-md; border: 1px solid var(--glass-edge); box-shadow: var(--shadow-sm); transform: rotate(-3deg); transition: transform var(--motion-hover) var(--ease-out); }
.character-current-text .character-current-kicker { @apply tw:text-accent; letter-spacing: .08em; }
.outfit-chip .archive-icon { @apply tw:w-[16px] tw:h-[16px] tw:shrink-0; }
.outfit-chip span { overflow-wrap: anywhere; }
@media (prefers-reduced-motion: reduce) { .character-browse-trigger :deep(.character-portrait) { transition: none; } .character-browse-button:hover .character-portrait { transform: none; } }
</style>
