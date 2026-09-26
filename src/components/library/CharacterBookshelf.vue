<template>
  <section class="character-bookshelf" aria-label="角色作品书架">
    <header class="bookshelf-header">
      <p class="bookshelf-total">{{ items.length }} 位角色<span aria-hidden="true"> · </span>{{ groups.length }} 部作品</p>
      <div class="bookshelf-modes" role="group" aria-label="角色浏览方式">
        <button type="button" :aria-pressed="showingShelf" @click="switchMode('shelf')"><ArchiveIcon name="gallery" />作品书架</button>
        <button type="button" :aria-pressed="!showingShelf" @click="switchMode('characters')"><ArchiveIcon name="character" />全部角色</button>
      </div>
    </header>

    <div class="bookshelf-search-row">
      <div class="bookshelf-search">
        <ArchiveIcon name="search" />
        <input :id="searchId" ref="searchInput" v-model="query" type="search" aria-label="搜索角色、别名或作品" placeholder="搜索角色、别名或作品…" @keydown="onSearchKeydown" />
      </div>
      <button v-if="term" type="button" class="bookshelf-text-button" @click="clearQuery">清除搜索</button>
      <p v-else class="bookshelf-hint">{{ showingShelf ? '挑一本作品，翻开角色的故事' : '选择角色，查看完整档案' }}</p>
    </div>

    <template v-if="showingShelf">
      <div v-if="groups.length" ref="shelfGrid" class="bookshelf-grid" role="group" aria-label="作品书架">
        <button v-for="group in groups" :key="group.key" type="button" class="bookshelf-work" :data-franchise="group.key" :aria-label="`${group.label}，${group.count} 位角色`" @click="enterGroup(group.key)">
          <span class="bookshelf-cover-stage" :class="{ 'is-empty': !group.covers.length }" aria-hidden="true">
            <span v-for="(cover, index) in group.covers" :key="cover.id" class="bookshelf-cover" :data-slot="index">
              <CharacterPortrait :src="cover.image" :name="cover.name" />
            </span>
            <span v-if="!group.covers.length" class="bookshelf-cover-placeholder"><ArchiveIcon name="gallery" /><span>封面待补充</span></span>
          </span>
          <span class="bookshelf-work-title">{{ group.label }}</span>
          <span class="bookshelf-work-count">{{ group.count }} 位角色<ArchiveIcon name="chevron-down" /></span>
        </button>
      </div>
      <p v-else class="bookshelf-empty" role="status">角色目录暂时为空。</p>
    </template>

    <template v-else>
      <div class="bookshelf-results-heading">
        <button type="button" class="bookshelf-text-button bookshelf-back" @click="backToShelf"><ArchiveIcon name="chevron-down" />返回书架</button>
        <h2 ref="resultsHeading" tabindex="-1">{{ term ? '搜索结果' : activeGroup?.label || '全部角色' }}</h2>
        <span role="status">{{ results.length }} 位角色</span>
      </div>
      <div ref="characterGrid" class="bookshelf-characters" role="group" aria-label="角色列表">
        <button v-for="item in visibleResults" :key="item.id" type="button" class="bookshelf-character" :data-character="item.id" :aria-pressed="selectedId === item.id" @click="emit('select', item.id)">
          <CharacterPortrait :src="item.image" :name="item.name" />
          <span class="bookshelf-character-copy"><strong>{{ item.name }}</strong><small>{{ franchiseLabel(franchiseKey(item.source)) || '未标注作品' }}</small></span>
          <span v-if="selectedId === item.id" class="bookshelf-selected"><ArchiveIcon name="success" /><span class="sr-only">当前角色</span></span>
        </button>
      </div>
      <div v-if="!results.length" class="bookshelf-empty" role="status">
        <ArchiveIcon name="search" /><p>没有找到匹配的角色</p><p class="bookshelf-hint">试试角色别名，或换一部作品。</p>
        <button type="button" class="bookshelf-text-button" @click="clearQuery">清除搜索</button>
      </div>
      <nav v-if="pageCount > 1" class="bookshelf-pagination" aria-label="角色分页">
        <button type="button" :disabled="page === 1" @click="changePage(page - 1)">上一页</button>
        <span role="status">第 {{ page }} / {{ pageCount }} 页</span>
        <button type="button" :disabled="page === pageCount" @click="changePage(page + 1)">下一页</button>
      </nav>
    </template>
  </section>
</template>

<script setup lang="ts">
import { nextTick, ref, useId } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import CharacterPortrait from './CharacterPortrait.vue'
import type { DirectoryCharacter } from './CharacterDirectory.vue'
import { useCharacterBookshelf } from '@/composables/useCharacterBookshelf'
import { franchiseKey, franchiseLabel } from '@/utils/franchiseLabel'

const props = defineProps<{ items: readonly DirectoryCharacter[]; selectedId?: string }>()
const emit = defineEmits<{ select: [id: string] }>()
const searchId = useId()
const searchInput = ref<HTMLInputElement | null>(null)
const shelfGrid = ref<HTMLElement | null>(null)
const characterGrid = ref<HTMLElement | null>(null)
const resultsHeading = ref<HTMLElement | null>(null)
const { query, series, page, term, groups, activeGroup, showingShelf, results, pageCount, visibleResults, openGroup, changeMode, clearSearch } = useCharacterBookshelf(() => props.items)

async function enterGroup(key: string) { openGroup(key); await nextTick(); resultsHeading.value?.focus() }
async function switchMode(value: 'shelf' | 'characters') { changeMode(value); await nextTick(); searchInput.value?.focus() }
async function backToShelf() {
  const key = series.value
  changeMode('shelf')
  await nextTick()
  const origin = [...(shelfGrid.value?.querySelectorAll<HTMLButtonElement>('[data-franchise]') || [])].find(button => button.dataset.franchise === key)
  ;(origin || searchInput.value)?.focus()
}
async function clearQuery() { clearSearch(); await nextTick(); searchInput.value?.focus() }
async function changePage(value: number) { page.value = value; await nextTick(); resultsHeading.value?.focus() }
function onSearchKeydown(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    ;(showingShelf.value ? shelfGrid.value : characterGrid.value)?.querySelector<HTMLButtonElement>('button')?.focus()
  }
  if (event.key === 'Enter' && term.value && visibleResults.value[0]) {
    event.preventDefault()
    emit('select', visibleResults.value[0].id)
  }
}
async function focusSelected() {
  await nextTick()
  const selected = [...(characterGrid.value?.querySelectorAll<HTMLButtonElement>('[data-character]') || [])].find(button => button.dataset.character === props.selectedId)
  ;(selected || searchInput.value)?.focus({ preventScroll: true })
}
defineExpose({ focusSelected })
</script>

<style scoped>
.character-bookshelf { min-width: 0; padding: clamp(20px, 2.5vw, 32px); border: 1px solid var(--border-soft); border-radius: var(--r-2xl); background: var(--bg-surface); color: var(--text-primary); }
.bookshelf-header { display: flex; align-items: center; justify-content: space-between; gap: var(--s-5); }
.bookshelf-total { margin: 0; color: var(--text-secondary); font-size: var(--fs-body-sm); }
.bookshelf-total span { margin-inline: var(--s-2); }
.bookshelf-modes { display: flex; gap: var(--s-1); flex-shrink: 0; padding: var(--s-1); border: 1px solid var(--border-soft); border-radius: var(--r-pill); background: var(--bg-base); }
.bookshelf-modes button { display: inline-flex; align-items: center; justify-content: center; gap: var(--s-2); border: 1px solid transparent; border-radius: var(--r-pill); padding: var(--s-2) var(--s-4); min-height: 40px; background: transparent; color: var(--text-secondary); font: inherit; font-size: var(--fs-label); cursor: pointer; }
.bookshelf-modes button[aria-pressed="true"] { background: var(--bg-surface); border-color: var(--border-soft); color: var(--accent); box-shadow: var(--shadow-sm); }
.bookshelf-search-row { display: flex; align-items: center; gap: var(--s-4); margin-top: var(--s-4); padding-bottom: var(--s-4); border-bottom: 1px solid var(--border-soft); }
.bookshelf-search { display: flex; align-items: center; gap: var(--s-3); flex: 1; max-width: 620px; min-width: 0; padding: 0 var(--s-4); border: 1px solid var(--border-soft); border-radius: var(--r-pill); background: var(--bg-base); color: var(--text-muted); }
.bookshelf-search:focus-within { outline: 2px solid var(--accent); outline-offset: 2px; }
.bookshelf-search input { width: 100%; min-width: 0; min-height: 46px; border: 0; outline: none; background: transparent; color: var(--text-primary); font: inherit; font-size: var(--fs-body-sm); }
.bookshelf-search input::placeholder { color: var(--text-muted); }
.bookshelf-hint { margin: 0; color: var(--text-muted); font-size: var(--fs-label); line-height: var(--lh-body); }
.bookshelf-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); column-gap: clamp(20px, 3vw, 48px); row-gap: var(--s-6); padding: var(--s-5) 0 var(--s-3); }
.bookshelf-work { min-width: 0; display: flex; flex-direction: column; align-items: center; padding: var(--s-2) 0 var(--s-4); border: 0; border-radius: var(--r-lg); background: transparent; color: inherit; font: inherit; cursor: pointer; }
.bookshelf-cover-stage { position: relative; display: block; width: 100%; aspect-ratio: 1.15; margin-bottom: var(--s-4); isolation: isolate; }
.bookshelf-cover { position: absolute; left: 21%; top: 5%; width: 58%; height: 86%; border: 3px solid var(--bg-surface); border-radius: var(--r-lg); box-shadow: var(--shadow-md); transform-origin: center 85%; transition: transform var(--motion-hover); overflow: hidden; }
.bookshelf-cover :deep(.character-portrait) { width: 100%; height: 100%; border: 0; border-radius: 0; }
.bookshelf-cover :deep(img) { transform: none; }
.bookshelf-cover[data-slot="0"] { z-index: calc(var(--z-base) + 4); transform: translateY(-3%); }
.bookshelf-cover[data-slot="1"] { z-index: calc(var(--z-base) + 3); transform: translate(-12%, 2%) rotate(-6deg); }
.bookshelf-cover[data-slot="2"] { z-index: calc(var(--z-base) + 2); transform: translate(12%, 3%) rotate(6deg); }
.bookshelf-cover[data-slot="3"] { z-index: calc(var(--z-base) + 1); transform: translate(-17%, 6%) rotate(-10deg); }
.bookshelf-cover[data-slot="4"] { z-index: var(--z-base); transform: translate(17%, 6%) rotate(10deg); }
.bookshelf-work-title { max-width: 100%; padding-inline: var(--s-2); font-size: var(--fs-body); font-weight: 600; line-height: var(--lh-body); overflow-wrap: anywhere; text-align: center; }
.bookshelf-work-count { display: flex; align-items: center; gap: var(--s-2); margin-top: var(--s-2); color: var(--text-muted); font-size: var(--fs-label); }
.bookshelf-work-count .archive-icon { transform: rotate(-90deg); color: var(--accent); }
.bookshelf-cover-placeholder { position: absolute; inset: 5% 21% 9%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--s-3); border: 1px dashed var(--border-soft); border-radius: var(--r-lg); background: var(--bg-base); color: var(--text-muted); font-size: var(--fs-label-xs); }
.bookshelf-cover-placeholder > .archive-icon { font-size: var(--fs-glyph); }
.bookshelf-text-button { display: inline-flex; align-items: center; justify-content: center; gap: var(--s-2); min-height: 40px; padding: var(--s-2); border: 0; border-radius: var(--r-sm); background: transparent; color: var(--accent); font: inherit; font-size: var(--fs-label); cursor: pointer; flex-shrink: 0; }
.bookshelf-text-button:hover { background: var(--accent-soft); }
.bookshelf-results-heading { display: flex; align-items: center; gap: var(--s-4); margin: var(--s-5) 0 var(--s-4); flex-wrap: wrap; }
.bookshelf-results-heading h2 { margin: 0; font-size: var(--fs-body-lg); line-height: var(--lh-body); font-weight: 600; }
.bookshelf-results-heading > span { margin-left: auto; color: var(--text-muted); font-size: var(--fs-label); }
.bookshelf-back .archive-icon { transform: rotate(90deg); }
.bookshelf-characters { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: var(--s-5) var(--s-4); }
.bookshelf-character { position: relative; display: flex; flex-direction: column; align-items: stretch; min-width: 0; padding: var(--s-2); border: 1px solid var(--border-soft); border-radius: var(--r-lg); background: var(--bg-base); color: var(--text-primary); text-align: left; font: inherit; cursor: pointer; transition: transform var(--motion-hover); }
.bookshelf-character :deep(.character-portrait) { width: 100%; height: auto; aspect-ratio: .78; border: 0; border-radius: var(--r-md); }
.bookshelf-character :deep(img) { transform: none; }
.bookshelf-character-copy { display: grid; gap: var(--s-1); padding: var(--s-3) var(--s-1) var(--s-1); overflow-wrap: anywhere; }
.bookshelf-character-copy strong { font-size: var(--fs-body-sm); font-weight: 600; line-height: var(--lh-body); }
.bookshelf-character-copy small { color: var(--text-muted); font-size: var(--fs-label-xs); line-height: var(--lh-body); }
.bookshelf-character[aria-pressed="true"] { border-color: var(--accent); background: var(--accent-soft); }
.bookshelf-selected { position: absolute; right: var(--s-3); top: var(--s-3); display: grid; place-items: center; width: 28px; height: 28px; border: 1px solid var(--accent); border-radius: var(--r-pill); background: var(--bg-surface); color: var(--accent); }
.bookshelf-empty { padding: var(--s-8) var(--s-4); text-align: center; color: var(--text-secondary); }
.bookshelf-empty > .archive-icon { font-size: var(--fs-title); }
.bookshelf-empty p { margin-block: var(--s-3); }
.bookshelf-pagination { display: flex; align-items: center; justify-content: center; gap: var(--s-5); margin-top: var(--s-6); color: var(--text-secondary); font-size: var(--fs-label); }
.bookshelf-pagination button { min-height: 40px; padding: var(--s-2) var(--s-4); border: 1px solid var(--border-soft); border-radius: var(--r-pill); background: var(--bg-base); color: var(--text-secondary); font: inherit; cursor: pointer; }
.bookshelf-pagination button:disabled { color: var(--text-disabled); cursor: default; }
.character-bookshelf button:focus-visible, .bookshelf-results-heading h2:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
@media (hover: hover) and (prefers-reduced-motion: no-preference) {
  html:not([data-reduced-motion="true"]) .bookshelf-work:hover .bookshelf-cover[data-slot="0"] { transform: translateY(-6%); }
  html:not([data-reduced-motion="true"]) .bookshelf-work:hover .bookshelf-cover[data-slot="1"] { transform: translate(-16%, 2%) rotate(-8deg); }
  html:not([data-reduced-motion="true"]) .bookshelf-work:hover .bookshelf-cover[data-slot="2"] { transform: translate(16%, 3%) rotate(8deg); }
  html:not([data-reduced-motion="true"]) .bookshelf-character:hover { transform: translateY(-3px); border-color: var(--accent); }
}
@media (max-width: 1200px) {
  .bookshelf-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .bookshelf-characters { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .bookshelf-header { align-items: flex-start; }
  .bookshelf-search-row > .bookshelf-hint { display: none; }
}
@media (max-width: 760px) {
  .character-bookshelf { padding: var(--s-5); }
  .bookshelf-header { flex-direction: column; gap: var(--s-4); }
  .bookshelf-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: var(--s-4); }
  .bookshelf-characters { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 480px) {
  .character-bookshelf { padding: var(--s-4); border-radius: var(--r-xl); }
  .bookshelf-grid { column-gap: var(--s-3); row-gap: var(--s-4); }
  .bookshelf-work-title { font-size: var(--fs-body-sm); }
  .bookshelf-cover { border-width: 2px; border-radius: var(--r-md); }
  .bookshelf-cover-stage { margin-bottom: var(--s-2); }
  .bookshelf-characters { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--s-3); }
  .bookshelf-search-row { gap: var(--s-1); margin-top: var(--s-4); }
  .bookshelf-results-heading { gap: var(--s-2); }
  .bookshelf-pagination { gap: var(--s-3); }
}
@media (prefers-reduced-motion: reduce) { .bookshelf-cover, .bookshelf-character { transition: none; } }
</style>
