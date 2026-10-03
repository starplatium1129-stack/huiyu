<template>
  <section class="character-bookshelf tw:min-w-0 tw:rounded-xl tw:text-primary" :class="{ 'is-keyboard-input': keyboardInput }" aria-label="角色作品书架" @keydown.capture="keyboardInput = true" @pointerdown.capture="keyboardInput = false">
    <header class="bookshelf-header tw:flex tw:items-center tw:justify-between tw:gap-s-5">
      <p class="bookshelf-total tw:m-0 tw:text-secondary tw:text-body-sm"><strong>{{ items.length }}</strong> 位角色<span aria-hidden="true"> · </span><strong>{{ groups.length }}</strong> 部作品</p>
      <div class="bookshelf-modes studio-segments tw:relative tw:isolate tw:flex tw:gap-s-1 tw:shrink-0 tw:p-s-1 tw:rounded-pill" role="group" aria-label="角色浏览方式">
        <AnimatedSelection />
        <button type="button" :aria-pressed="showingShelf" @click="switchMode('shelf')"><ArchiveIcon name="gallery" />作品书架</button>
        <button type="button" :aria-pressed="!showingShelf" @click="switchMode('characters')"><ArchiveIcon name="character" />全部角色</button>
      </div>
    </header>

    <div class="bookshelf-search-row tw:flex tw:items-center tw:gap-s-4 tw:mt-s-4 tw:pb-s-4">
      <StudioSearch :id="searchId" ref="searchInput" v-model="query" class="bookshelf-search" label="搜索角色、别名或作品" placeholder="搜索角色、别名或作品…" @keydown="onSearchKeydown" />
      <p class="bookshelf-hint tw:m-0 tw:text-muted tw:text-label tw:leading-body">{{ showingShelf ? '挑一本作品，翻开角色的故事' : '选择角色，查看完整档案' }}</p>
    </div>

    <div ref="contentRoot">
    <template v-if="showingShelf">
      <div v-if="groups.length" ref="shelfGrid" class="bookshelf-grid tw:grid" role="group" aria-label="作品书架">
        <article v-for="group in groups" :key="group.key" class="bookshelf-work tw:min-w-0 tw:flex tw:flex-col tw:items-center tw:rounded-lg tw:cursor-pointer">
        <button type="button" class="bookshelf-open tw:w-full tw:flex tw:flex-col tw:items-center tw:p-0 tw:rounded-lg tw:cursor-pointer" :data-franchise="group.key" :aria-label="`${group.label}，${group.count} 位角色`" @click="enterGroup(group.key)">
          <span class="bookshelf-cover-stage tw:relative tw:block tw:w-full tw:mb-s-4 tw:isolate" :class="{ 'is-empty': !group.covers.length }" aria-hidden="true">
            <span v-for="(cover, index) in rotatedCovers(group.key, group.covers)" :key="cover.id" class="bookshelf-cover tw:absolute tw:left-[21%] tw:top-[5%] tw:w-[58%] tw:h-[86%] tw:rounded-lg tw:overflow-hidden" :data-slot="index">
              <CharacterPortrait :src="cover.image" :name="cover.name" />
            </span>
            <span v-if="!group.covers.length" class="bookshelf-cover-placeholder tw:absolute tw:flex tw:flex-col tw:items-center tw:justify-center tw:gap-s-3 tw:rounded-lg tw:text-muted tw:text-label-xs"><ArchiveIcon name="gallery" /><span>封面待补充</span></span>
          </span>
          <span class="bookshelf-work-title tw:max-w-full tw:text-body tw:font-semibold tw:leading-body tw:text-center">{{ group.label }}</span>
          <span class="bookshelf-work-count tw:flex tw:items-center tw:gap-s-2 tw:mt-s-2 tw:text-muted tw:text-label">{{ group.count }} 位角色<ArchiveIcon name="chevron-down" /></span>
        </button>
        <div v-if="group.covers.length > 1" class="bookshelf-flip-row tw:flex tw:items-center tw:justify-center tw:gap-s-2 tw:w-full tw:mt-s-2 tw:text-secondary tw:text-label-xs">
          <span aria-live="polite">{{ rotatedCovers(group.key, group.covers)[0]?.name }}</span>
          <button type="button" :aria-label="`下一张封面：${group.label}`" @click="coverOffsets[group.key] = ((coverOffsets[group.key] || 0) + 1) % group.covers.length"><ArchiveIcon name="refresh" /><span>{{ ((coverOffsets[group.key] || 0) % group.covers.length) + 1 }} / {{ group.covers.length }}</span></button>
        </div>
        </article>
      </div>
      <p v-else class="bookshelf-empty tw:text-center tw:text-secondary" role="status">角色目录暂时为空。</p>
    </template>

    <template v-else>
      <div class="bookshelf-results-heading tw:flex tw:items-center tw:gap-s-4 tw:flex-wrap">
        <button type="button" class="bookshelf-text-button bookshelf-back" @click="backToShelf"><ArchiveIcon name="chevron-down" />返回书架</button>
        <h2 ref="resultsHeading" tabindex="-1">{{ term ? '搜索结果' : activeGroup?.label || '全部角色' }}</h2>
        <span role="status">{{ results.length }} 位角色</span>
      </div>
      <div ref="characterGrid" class="bookshelf-characters tw:grid" role="group" aria-label="角色列表">
        <button v-for="item in visibleResults" :key="item.id" type="button" class="bookshelf-character tw:relative tw:flex tw:flex-col tw:items-stretch tw:min-w-0 tw:p-s-2 tw:rounded-lg tw:text-primary tw:text-left tw:cursor-pointer" :data-character="item.id" :aria-pressed="selectedId === item.id" @click="emit('select', item.id)">
          <CharacterPortrait :src="item.image" :name="item.name" />
          <span class="bookshelf-character-copy tw:grid tw:gap-s-1"><strong>{{ item.name }}</strong><small>{{ franchiseLabel(franchiseKey(item.source)) || '未标注作品' }}</small></span>
          <span v-if="selectedId === item.id" class="bookshelf-selected tw:absolute tw:right-s-3 tw:top-s-3 tw:grid tw:w-[28px] tw:h-[28px] tw:rounded-pill tw:text-accent"><ArchiveIcon name="success" /><span class="sr-only">当前角色</span></span>
        </button>
      </div>
      <div v-if="!results.length" class="bookshelf-empty tw:text-center tw:text-secondary" role="status">
        <ArchiveIcon name="search" /><p>没有找到匹配的角色</p><p class="bookshelf-hint tw:m-0 tw:text-muted tw:text-label tw:leading-body">试试角色别名，或换一部作品。</p>
        <button type="button" class="bookshelf-text-button" @click="clearQuery">清除搜索</button>
      </div>
      <nav v-if="pageCount > 1" class="bookshelf-pagination tw:flex tw:items-center tw:justify-center tw:gap-s-5 tw:mt-s-6 tw:text-secondary tw:text-label" aria-label="角色分页">
        <button type="button" :disabled="page === 1" @click="changePage(page - 1)">上一页</button>
        <span role="status">第 {{ page }} / {{ pageCount }} 页</span>
        <button type="button" :disabled="page === pageCount" @click="changePage(page + 1)">下一页</button>
      </nav>
    </template>
    </div>
  </section>
</template>

<script setup lang="ts">
import { nextTick, onScopeDispose, ref, useId } from 'vue'
import { useFluidSurface } from '@/composables/useFluidSurface'
import { captureScrollAnchor, restoreScrollAnchor, type ScrollAnchor } from '@/utils/scrollAnchor'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import CharacterPortrait from './CharacterPortrait.vue'
import StudioSearch from '@/components/ui/StudioSearch.vue'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import type { DirectoryCharacter } from './CharacterDirectory.vue'
import { useCharacterBookshelf } from '@/composables/useCharacterBookshelf'
import { franchiseKey, franchiseLabel } from '@/utils/franchiseLabel'

const props = defineProps<{ items: readonly DirectoryCharacter[]; selectedId?: string }>()
const emit = defineEmits<{ select: [id: string] }>()
const searchId = useId()
const searchInput = ref<InstanceType<typeof StudioSearch> | null>(null)
const shelfGrid = ref<HTMLElement | null>(null)
const characterGrid = ref<HTMLElement | null>(null)
const resultsHeading = ref<HTMLElement | null>(null)
const contentRoot = ref<HTMLElement | null>(null)
const contentMotion = useFluidSurface()
const keyboardInput = ref(false)
let shelfAnchor: ScrollAnchor | null = null
let cancelRestore = () => {}
let revision = 0
function interruptNavigation() { cancelRestore(); return ++revision }
onScopeDispose(interruptNavigation)
const coverOffsets = ref<Record<string, number>>({})
function rotatedCovers(key: string, covers: readonly DirectoryCharacter[]) {
  const offset = (coverOffsets.value[key] || 0) % (covers.length || 1)
  return [...covers.slice(offset), ...covers.slice(0, offset)]
}
const { query, series, page, term, groups, activeGroup, showingShelf, results, pageCount, visibleResults, openGroup, changeMode, clearSearch } = useCharacterBookshelf(() => props.items)

function revealContent() {
  const element = contentRoot.value
  if (!element) return
  if (keyboardInput.value) { contentMotion.dispose(element); return }
  contentMotion.enter(element, () => contentMotion.dispose(element))
}
function focusResults() {
  const heading = resultsHeading.value
  if (!heading) return
  heading.focus({ preventScroll: true })
  if (heading.getBoundingClientRect().top < 70) heading.scrollIntoView({ block: 'start', behavior: 'instant' })
}
async function enterGroup(key: string) {
  const version = interruptNavigation(); shelfAnchor = captureScrollAnchor()
  openGroup(key); await nextTick()
  if (version !== revision) return
  focusResults(); revealContent()
}
async function switchMode(value: 'shelf' | 'characters') {
  if (value === 'shelf' && showingShelf.value || value === 'characters' && !showingShelf.value && series.value === null && !term.value) return
  const version = interruptNavigation()
  if (showingShelf.value) shelfAnchor = captureScrollAnchor()
  changeMode(value); await nextTick()
  if (version !== revision) return
  if (value === 'shelf' && shelfAnchor) cancelRestore = restoreScrollAnchor(shelfAnchor, { immediate: true, shouldContinue: () => version === revision && showingShelf.value })
  searchInput.value?.focus({ preventScroll: true }); revealContent()
}
async function backToShelf() {
  const key = series.value
  const version = interruptNavigation()
  changeMode('shelf')
  await nextTick()
  if (version !== revision) return
  if (shelfAnchor) cancelRestore = restoreScrollAnchor(shelfAnchor, { immediate: true, shouldContinue: () => version === revision && showingShelf.value })
  const origin = [...(shelfGrid.value?.querySelectorAll<HTMLButtonElement>('[data-franchise]') || [])].find(button => button.dataset.franchise === key)
  ;(origin || searchInput.value)?.focus({ preventScroll: true })
  revealContent()
}
async function clearQuery() { const version = interruptNavigation(); clearSearch(); await nextTick(); if (version === revision) searchInput.value?.focus() }
async function changePage(value: number) { const version = interruptNavigation(); page.value = value; await nextTick(); if (version === revision) { focusResults(); revealContent() } }
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
@reference "../../assets/css/tailwind.css";
.character-bookshelf { padding: clamp(20px, 2.5vw, 32px); border: 1px solid var(--border-soft); background: var(--bg-surface); }
.bookshelf-total strong { @apply tw:text-primary tw:font-semibold; }
.bookshelf-total span { margin-inline: var(--s-2); }
.bookshelf-modes { --selection-radius:var(--r-pill); border: 1px solid transparent; background: var(--bg-base); }
.bookshelf-modes button { @apply tw:relative; z-index:var(--z-raised); @apply tw:inline-flex tw:items-center tw:justify-center tw:gap-s-2; border: 1px solid transparent; @apply tw:rounded-pill; padding: var(--s-2) var(--s-4); @apply tw:min-h-[40px]; background: transparent; @apply tw:text-secondary; font: inherit; @apply tw:text-label tw:cursor-pointer; }
.bookshelf-modes button[aria-pressed="true"] { @apply tw:text-accent; }
.bookshelf-search-row { border-bottom: 0; }
.bookshelf-search { flex:1; @apply tw:max-w-[620px]; }
.bookshelf-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); column-gap: clamp(20px, 3vw, 48px); @apply tw:gap-y-s-6; padding: var(--s-5) 0 var(--s-3); }
.bookshelf-open { border:0; background:transparent; color:inherit; font:inherit; }
.bookshelf-flip-row > span { @apply tw:min-w-0 tw:max-w-[60%] tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap; }
.bookshelf-flip-row button { @apply tw:flex tw:items-center tw:gap-s-1 tw:shrink-0 tw:min-h-[36px]; padding:var(--s-1) var(--s-2); border:1px solid transparent; @apply tw:rounded-pill; background:transparent; @apply tw:text-secondary; font:inherit; @apply tw:cursor-pointer; }
.bookshelf-flip-row button:hover { background:var(--bg-base); @apply tw:text-accent; }
.bookshelf-work { padding: var(--s-2) 0 var(--s-4); border: 0; background: transparent; color: inherit; font: inherit; }
.bookshelf-cover-stage { aspect-ratio: 1.15; }
.bookshelf-cover { border: 3px solid var(--bg-surface); box-shadow: var(--shadow-md); transform-origin: center 85%; transition: transform var(--motion-hover) var(--ease-out); }
.bookshelf-cover :deep(.character-portrait) { @apply tw:w-full tw:h-full; border: 0; border-radius: 0; }
.bookshelf-cover :deep(img) { transform: none; }
.bookshelf-cover[data-slot="0"] { z-index: calc(var(--z-base) + 4); transform: translateY(-3%); }
.bookshelf-cover[data-slot="1"] { z-index: calc(var(--z-base) + 3); transform: translate(-12%, 2%) rotate(-6deg); }
.bookshelf-cover[data-slot="2"] { z-index: calc(var(--z-base) + 2); transform: translate(12%, 3%) rotate(6deg); }
.bookshelf-cover[data-slot="3"] { z-index: calc(var(--z-base) + 1); transform: translate(-17%, 6%) rotate(-10deg); }
.bookshelf-cover[data-slot="4"] { z-index: var(--z-base); transform: translate(17%, 6%) rotate(10deg); }
.bookshelf-work-title { padding-inline: var(--s-2); overflow-wrap: anywhere; }
.bookshelf-work-count .archive-icon { transform: rotate(-90deg); @apply tw:text-accent; }
.bookshelf-cover-placeholder { inset: 5% 21% 9%; border: 1px dashed var(--border-soft); background: var(--bg-base); }
.bookshelf-cover-placeholder > .archive-icon { @apply tw:text-glyph; }
.bookshelf-text-button { @apply tw:inline-flex tw:items-center tw:justify-center tw:gap-s-2 tw:min-h-[40px] tw:p-s-2; border: 0; @apply tw:rounded-sm; background: transparent; @apply tw:text-accent; font: inherit; @apply tw:text-label tw:cursor-pointer tw:shrink-0; }
.bookshelf-text-button:hover { background: var(--accent-soft); }
.bookshelf-results-heading { margin: var(--s-5) 0 var(--s-4); }
.bookshelf-results-heading h2 { @apply tw:m-0 tw:text-body-lg tw:leading-body tw:font-semibold; }
.bookshelf-results-heading > span { @apply tw:ml-auto tw:text-muted tw:text-label; }
.bookshelf-back .archive-icon { transform: rotate(90deg); }
.bookshelf-characters { grid-template-columns: repeat(6, minmax(0, 1fr)); gap: var(--s-5) var(--s-4); }
.bookshelf-character { border: 1px solid transparent; background: var(--bg-base); font: inherit; transform-origin: center bottom; }
/* A quiet card edge; fade a prepainted shadow instead of animating its blur. */
.bookshelf-character::before { content: ''; position: absolute; inset: -1px; border: 1px solid var(--border-strong); border-radius: inherit; box-shadow: var(--shadow-sm); opacity: 0; pointer-events: none; }
.bookshelf-character:focus-visible::before { opacity: 1; }
.bookshelf-character :deep(.character-portrait) { @apply tw:w-full tw:h-auto; aspect-ratio: .78; border: 0; @apply tw:rounded-md; }
.bookshelf-character :deep(img) { transform: none; }
.bookshelf-character-copy { padding: var(--s-3) var(--s-1) var(--s-1); overflow-wrap: anywhere; }
.bookshelf-character-copy strong { @apply tw:text-body-sm tw:font-semibold tw:leading-label; }
.bookshelf-character-copy small { @apply tw:text-secondary tw:text-label-xs tw:leading-body; display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden; }
.bookshelf-character[aria-pressed="true"] { @apply tw:border-accent; background: var(--accent-soft); }
.bookshelf-selected { place-items: center; border: 1px solid var(--accent); background: var(--bg-surface); }
.bookshelf-empty { padding: var(--s-8) var(--s-4); }
.bookshelf-empty > .archive-icon { @apply tw:text-title; }
.bookshelf-empty p { margin-block: var(--s-3); }
.bookshelf-pagination button { @apply tw:min-h-[40px]; padding: var(--s-2) var(--s-4); border: 1px solid var(--border-soft); @apply tw:rounded-pill; background: var(--bg-base); @apply tw:text-secondary; font: inherit; @apply tw:cursor-pointer; }
.bookshelf-pagination button:disabled { @apply tw:text-disabled tw:cursor-default; }
.character-bookshelf button:focus-visible, .bookshelf-results-heading h2:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
.sr-only { @apply tw:absolute tw:w-[1px] tw:h-[1px] tw:p-0 tw:m-[-1px] tw:overflow-hidden; clip-path: inset(50%); @apply tw:whitespace-nowrap; border: 0; }
@media (hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference) {
  html:not([data-reduced-motion="true"]) .bookshelf-work:hover .bookshelf-cover[data-slot="0"] { transform: translateY(-6%); }
  html:not([data-reduced-motion="true"]) .bookshelf-work:hover .bookshelf-cover[data-slot="1"] { transform: translate(-16%, 2%) rotate(-8deg); }
  html:not([data-reduced-motion="true"]) .bookshelf-work:hover .bookshelf-cover[data-slot="2"] { transform: translate(16%, 3%) rotate(8deg); }
  html:not([data-reduced-motion="true"]) .bookshelf-character { transition: transform var(--motion-hover) var(--ease-out); }
  html:not([data-reduced-motion="true"]) .bookshelf-character::before { transition: opacity var(--motion-hover) var(--ease-out); }
  html:not([data-reduced-motion="true"]) .bookshelf-character:hover { transform: perspective(900px) translateY(-2px) rotateX(.6deg); }
  html:not([data-reduced-motion="true"]) .bookshelf-character:active { transform: translateY(0) scale(.995); }
}
@media (hover: hover) and (pointer: fine) {
  .bookshelf-character:hover::before { opacity: 1; }
}
.bookshelf-character[aria-pressed="true"]::before { border-color: var(--accent); }
.is-keyboard-input .bookshelf-cover { transition:none; }
@media (max-width: 1200px) {
  .bookshelf-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .bookshelf-characters { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .bookshelf-header { @apply tw:items-start; }
  .bookshelf-search-row > .bookshelf-hint { @apply tw:hidden; }
}
@media (max-width: 760px) {
  .character-bookshelf { @apply tw:p-s-5; }
  .bookshelf-header { @apply tw:flex-col tw:gap-s-4; }
  .bookshelf-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); @apply tw:gap-x-s-4; }
  .bookshelf-characters { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 480px) {
  .character-bookshelf { @apply tw:p-s-4 tw:rounded-xl; }
  .bookshelf-grid { @apply tw:gap-x-s-3 tw:gap-y-s-4; }
  .bookshelf-work-title { @apply tw:text-body-sm; }
  .bookshelf-cover { border-width: 2px; @apply tw:rounded-md; }
  .bookshelf-cover-stage { @apply tw:mb-s-2; }
  .bookshelf-characters { grid-template-columns: repeat(2, minmax(0, 1fr)); @apply tw:gap-s-3; }
  .bookshelf-search-row { @apply tw:gap-s-1 tw:mt-s-4; }
  .bookshelf-results-heading { @apply tw:gap-s-2; }
  .bookshelf-pagination { @apply tw:gap-s-3; }
}
@media (prefers-reduced-motion: reduce) { .bookshelf-cover, .bookshelf-character { transition: none; } }
</style>
