<script setup lang="ts">
import { resolveRuntimeUrl } from '@/platform/runtimeUrl'

import { popularPortraitSrc } from '@/utils/popularPortraitSource'
import { computed, ref } from 'vue'
import type { PopularCharacter, PopularOutfit } from '@/utils/popularContent'
import { franchiseKey, franchiseLabel } from '@/utils/franchiseLabel'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import CharacterDirectoryDialog from '@/components/library/CharacterDirectoryDialog.vue'
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

const browser = ref<InstanceType<typeof CharacterDirectoryDialog> | null>(null)
const directoryOpened = ref(false)
const searchProxy = computed({ get: () => props.search, set: value => emit('update:search', value) })
const directoryItems = computed(() => directoryOpened.value
  ? props.characters.map(character => ({ id: character.id, name: character.displayName, source: character.franchise, aliases: character.aliases, image: popularPortraitSrc(character.id) }))
  : [])
function openBrowser(event: MouseEvent) {
  directoryOpened.value = true
  if (event.currentTarget instanceof HTMLElement) void browser.value?.open(event.currentTarget)
}
function selectFromDirectory(id: string) {
  const character = props.characters.find(item => item.id === id)
  if (character) emit('select', character)
}

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
    <button type="button" class="character-browse-button tw:grid tw:gap-0 tw:w-full tw:min-w-0 tw:p-0 tw:rounded-lg tw:overflow-hidden tw:text-left tw:cursor-pointer" aria-haspopup="dialog" @click="openBrowser">
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
    <CharacterDirectoryDialog ref="browser" v-model:search="searchProxy" title="挑选这一幕的主角"
      description="先按作品缩小范围，再点击肖像即可带回工作台。" :items="directoryItems" :selected-id="selectedCharacterId"
      @select="selectFromDirectory" />
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
.character-browse-button:focus-visible { outline: none; box-shadow: var(--focus-shadow); @apply tw:rounded-lg; }
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
@media (hover:hover) and (pointer:fine) { .character-browse-button:hover:not(:focus-visible) .character-portrait { transform:rotate(0deg) translateY(-2px); } }
.character-browse-button:hover .character-browse-all { background: var(--bg-hover); }
.character-browse-button:active:not(:focus-visible) .character-browse-all { transform: scale(.98); }
.character-browse-button:focus-visible .character-browse-all { transition:none; }

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
.outfit-chip:hover { @apply tw:border-strong tw:text-primary; }
.outfit-chip:focus-visible { outline: none; box-shadow: var(--focus-shadow); }
.outfit-chip.active {
  @apply tw:border-strong;
  background: var(--bg-surface);
  @apply tw:text-primary;
  box-shadow: var(--selection-shadow);
}
@media (prefers-reduced-motion: reduce) {
  :root:not([data-motion='full']) .character-browse-button:active .character-browse-all { transform: none; }
}
.character-browse-trigger :deep(.character-portrait) { @apply tw:w-[86px] tw:h-[116px] tw:rounded-md; border: 1px solid var(--glass-edge); box-shadow: var(--shadow-sm); transform: rotate(-3deg); transition: transform var(--motion-hover) var(--ease-out); }
.character-current-text .character-current-kicker { @apply tw:text-accent; letter-spacing: .08em; }
.outfit-chip .archive-icon { @apply tw:w-[16px] tw:h-[16px] tw:shrink-0; }
.outfit-chip span { overflow-wrap: anywhere; }
@media (prefers-reduced-motion: reduce) { :root:not([data-motion='full']) .character-browse-trigger :deep(.character-portrait) { transition: none; } :root:not([data-motion='full']) .character-browse-button:hover .character-portrait { transform: none; } }
:root:is([data-motion='reduce'],[data-motion='reduced']) .character-browse-all,
:root:is([data-motion='reduce'],[data-motion='reduced']) .character-browse-button .character-portrait,
.character-browse-button:focus-visible .character-portrait { transform:none; transition:none; }
</style>
