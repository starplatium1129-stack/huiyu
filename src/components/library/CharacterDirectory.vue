<template>
  <aside class="character-directory" :class="{ 'directory-catalog': catalog }" aria-label="角色目录">
    <!-- 作品筛选：宽屏独立侧栏，窄屏折叠为单行横向筛选，始终只有一个纵向滚动区 -->
    <div v-if="catalog" class="directory-rail tw:flex tw:flex-col tw:gap-s-2 tw:min-w-0 tw:min-h-0 tw:pr-s-3">
      <p class="directory-rail-title tw:m-0 tw:text-muted tw:text-label-xs tw:font-semibold">按作品筛选</p>
      <div ref="rail" class="directory-series tw:flex tw:flex-col tw:gap-s-1 tw:min-h-0 tw:overflow-y-auto" role="group" aria-label="按作品浏览" @keydown="onRailKeys">
        <button type="button" :aria-pressed="!series" @click="series = ''">全部作品</button>
        <button v-for="group in groups" :key="group.key" type="button"
          :aria-pressed="series === group.key" @click="series = group.key">{{ group.label }} <span>{{ group.count }}</span></button>
      </div>
    </div>
    <div class="directory-main tw:flex tw:min-h-0">
      <div class="directory-tools">
        <label class="directory-heading" :for="inputId">选择角色 <span v-if="!catalog">{{ items.length }}</span></label>
        <input :id="inputId" v-model="query" type="search" aria-label="搜索角色或作品" placeholder="角色名、作品或别名…" :autofocus="catalog" @keydown="onSearchKeydown" />
        <StudioSelect v-if="!catalog" v-model="series" label="筛选角色系列" :options="[{ value: '', label: '全部系列' }, ...groups.map(group => ({ value: group.key, label: `${group.label} · ${group.count}` }))]" />
        <div class="directory-count"><span role="status">找到 {{ results.length }} 位角色</span><button v-if="query || series" type="button" @click="query = ''; series = ''">清除筛选</button></div>
      </div>
      <div ref="list" class="directory-list tw:min-h-[120px] tw:overflow-y-auto" role="group" aria-label="角色列表" @keydown="onListKeys">
        <button v-for="item in visibleResults" :key="item.id" type="button" class="directory-item" :data-character="item.id" :tabindex="tabStopId === item.id ? 0 : -1" @focus="focusedId = item.id" :aria-pressed="selectedId === item.id" @click="emit('select', item.id)">
          <CharacterPortrait :src="resolveRuntimeUrl(item.image)" :name="item.name" />
          <span class="directory-label">
            <strong>{{ item.name }}</strong>
            <StudioTooltip :content="franchiseLabel(franchiseKey(item.source))">
              <small>{{ franchiseLabel(franchiseKey(item.source)) }}</small>
            </StudioTooltip>
          </span>
          <span v-if="selectedId === item.id" class="directory-selected tw:ml-auto tw:text-accent" aria-hidden="true"><ArchiveIcon name="success" /></span>
        </button>
        <div v-if="!results.length" class="directory-empty tw:text-muted tw:text-label">没有匹配的角色。<br />试试其他名字，或清除筛选。</div>
      </div>
      <nav v-if="pageCount > 1" class="directory-pagination tw:flex tw:justify-between tw:items-center tw:gap-s-2 tw:mt-s-2 tw:text-secondary tw:text-label tw:shrink-0" aria-label="角色分页">
        <button type="button" :disabled="page === 1" @click="page--">上一页</button>
        <label>第 <StudioSelect v-model.number="page" label="跳转角色页" inline size="sm" :options="pageItems.map(n => ({ value: n, label: String(n) }))" /> / {{ pageCount }} 页</label>
        <button type="button" :disabled="page === pageCount" @click="page++">下一页</button>
      </nav>
      <div class="directory-current tw:text-label-xs tw:text-secondary tw:shrink-0"><span>当前：{{ selected?.name || '未选择' }}</span><button v-if="selected" type="button" @click="locateSelected">定位</button></div>
    </div>
  </aside>
</template>
<script setup lang="ts">
import { resolveRuntimeUrl } from '@/platform/runtimeUrl'

import { computed, nextTick, ref, useId, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import CharacterPortrait from './CharacterPortrait.vue'
import { franchiseKey, franchiseLabel } from '@/utils/franchiseLabel'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
export interface DirectoryCharacter { id: string; name: string; source: string; image?: string; aliases?: string[] }
const props = withDefaults(defineProps<{ items: DirectoryCharacter[]; selectedId: string; catalog?: boolean; pageSize?: number }>(), { catalog: false, pageSize: 0 })
const emit = defineEmits<{ select: [id: string]; dismiss: [] }>()
const inputId = useId()
const query = defineModel<string>('search', { default: '' })
const series = ref('')
const page = ref(1)
const list = ref<HTMLElement | null>(null)
const rail = ref<HTMLElement | null>(null)
const focusedId = ref(props.selectedId)
const selected = computed(() => props.items.find(item => item.id === props.selectedId))
/** 选中项变化时把结果区落到它所在的页并滚入视野：打开弹窗即可看到当前角色，不用先找页。 */
watch([() => props.selectedId, () => props.pageSize], async () => {
  await nextTick()
  const index = results.value.findIndex(item => item.id === props.selectedId)
  if (props.pageSize && index >= 0) page.value = Math.floor(index / props.pageSize) + 1
  await nextTick()
  list.value?.querySelector<HTMLElement>('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest' })
}, { immediate: true })
const groups = computed(() => {
  const counts = new Map<string, number>()
  for (const item of props.items) { const key = franchiseKey(item.source); counts.set(key, (counts.get(key) || 0) + 1) }
  return [...counts].map(([key, count]) => ({ key, count, label: franchiseLabel(key) })).sort((a, b) => (props.catalog ? b.count - a.count : 0) || a.label.localeCompare(b.label, 'zh-CN'))
})
const indexed = computed(() => props.items.map(item => ({ item, key: franchiseKey(item.source), text: [item.id, item.name, item.source, franchiseLabel(franchiseKey(item.source)), ...(item.aliases || [])].join(' ').toLocaleLowerCase() })))
const results = computed(() => {
  const term = query.value.trim().toLocaleLowerCase()
  return indexed.value.filter(row => (!series.value || row.key === series.value) && (!term || row.text.includes(term))).map(row => row.item)
    .sort((a, b) => Number(b.name.toLocaleLowerCase() === term) - Number(a.name.toLocaleLowerCase() === term))
})
const pageCount = computed(() => props.pageSize ? Math.max(1, Math.ceil(results.value.length / props.pageSize)) : 1)
/** 页码跳转选项：1 … pageCount，供 StudioSelect 渲染（原生分页 <select> 已迁移）。 */
const pageItems = computed(() => Array.from({ length: pageCount.value }, (_, i) => i + 1))
const visibleResults = computed(() => props.pageSize ? results.value.slice((page.value - 1) * props.pageSize, page.value * props.pageSize) : results.value)
const tabStopId = computed(() => visibleResults.value.find(item => item.id === focusedId.value)?.id
  || visibleResults.value.find(item => item.id === props.selectedId)?.id || visibleResults.value[0]?.id || '')
watch(() => props.selectedId, id => { focusedId.value = id })
watch(visibleResults, async items => {
  // Only repair focus when the focused result disappears; typing/filter controls keep focus.
  const focused = document.activeElement as HTMLElement | null
  if (!focused || !list.value?.contains(focused) || items.some(item => item.id === focused.dataset.character)) return
  await nextTick()
  const replacement = list.value?.querySelector<HTMLButtonElement>('button[tabindex="0"]')
  ;(replacement || document.getElementById(inputId))?.focus({ preventScroll: true })
})
watch([query, series], () => { page.value = 1 })
watch(pageCount, count => { page.value = Math.min(page.value, count) })
watch(page, async () => { await nextTick(); if (list.value) list.value.scrollTop = 0 })
function focusFirst() { list.value?.querySelector<HTMLButtonElement>('button')?.focus() }
/** 同一组内循环移动焦点；容器既可能是纵向侧栏，也可能是窄屏的单行筛选。 */
function moveIn(container: HTMLElement | null, step: number) {
  const buttons = [...(container?.querySelectorAll<HTMLButtonElement>('button') || [])]
  if (!buttons.length) return
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
  const next = buttons[(index + step + buttons.length) % buttons.length]
  next?.focus()
  next?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}
function onListKeys(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey
    || !(event.target instanceof HTMLButtonElement) || event.target.parentElement !== list.value) return
  const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
  if (step) { event.preventDefault(); moveIn(list.value, step) }
  else if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault()
    const buttons = list.value?.querySelectorAll<HTMLButtonElement>('.directory-item')
    const button = event.key === 'Home' ? buttons?.[0] : buttons?.[buttons.length - 1]
    button?.focus(); button?.scrollIntoView({ block: 'nearest' })
  }
}
function onRailKeys(event: KeyboardEvent) {
  const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1
    : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 0
  if (!step) return
  event.preventDefault()
  moveIn(rail.value, step)
}
/**
 * 弹窗语境（catalog）下 Esc 关闭弹窗并保留搜索，而不是让 `<input type="search">`
 * 的原生「Esc 清空输入」抢先吃掉按键：那样第一次 Esc 只清空搜索、弹窗不关，
 * 与「Esc 关闭弹窗、关闭不丢搜索上下文」的既有约定冲突。
 * 非弹窗目录（角色档案、热门场景）没有 dismiss 监听，保持浏览器原生清空行为。
 */
function onSearchKeydown(event: KeyboardEvent) {
  // 组合输入的确认、取消和候选导航由输入法处理，不触发角色选择或关闭。
  if (event.isComposing || event.keyCode === 229) return
  if (event.key === 'Escape' && props.catalog) {
    event.preventDefault()
    emit('dismiss')
  } else if (event.key === 'Enter' && results.value[0]) {
    event.preventDefault()
    emit('select', results.value[0].id)
  } else if (event.key === 'ArrowDown') {
    event.preventDefault()
    focusFirst()
  }
}
async function locateSelected() {
  query.value = ''; series.value = ''; await nextTick()
  const index = results.value.findIndex(item => item.id === props.selectedId)
  page.value = props.pageSize && index >= 0 ? Math.floor(index / props.pageSize) + 1 : 1
  await nextTick()
  const button = list.value?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')
  button?.scrollIntoView({ block: 'nearest' }); button?.focus({ preventScroll: true })
}
</script>
<style scoped>
@reference "../../assets/css/tailwind.css";
.character-directory { @apply tw:sticky tw:top-[82px] tw:flex tw:flex-col; max-height: max(360px, calc(100dvh - 280px)); border: 1px solid var(--border-soft); @apply tw:rounded-xl; background: var(--bg-surface); @apply tw:overflow-hidden; }
.directory-main { @apply tw:flex-col; flex: 1 1 auto; }
.directory-tools { @apply tw:p-s-4 tw:grid tw:gap-s-3 tw:shrink-0; }
.directory-heading { @apply tw:flex tw:justify-between tw:text-body-sm tw:font-semibold; }
.directory-heading span, .directory-count { @apply tw:text-muted tw:text-label-xs; }
.directory-tools input { @apply tw:min-w-0 tw:w-full tw:min-h-[40px]; padding: var(--s-2) var(--s-3); @apply tw:text-primary; background: var(--bg-deep); border: 1px solid var(--border-soft); @apply tw:rounded-md; font: inherit; @apply tw:text-label; }
/* 原生 <select> 已迁移为 StudioSelect：外观由组件统一提供；布局（宽度）落在 wrapper。 */
.directory-tools .studio-select-wrapper { @apply tw:w-full tw:min-w-0 tw:min-h-[40px]; }
.directory-count, .directory-current { @apply tw:flex tw:justify-between tw:items-center tw:gap-s-2; }
.directory-count button, .directory-current button { @apply tw:min-h-[32px] tw:px-s-2 tw:py-s-1 tw:rounded-md tw:shrink-0; border: 0; background: transparent; @apply tw:text-accent tw:cursor-pointer; font: inherit; }
.directory-count button:hover, .directory-current button:hover { background:var(--accent-soft); }
.directory-list { flex: 1 1 auto; overscroll-behavior: contain; padding: 0 var(--s-2) var(--s-2); scrollbar-width: thin; scroll-padding-block: var(--s-2); }
.directory-item { @apply tw:w-full tw:flex tw:items-center tw:gap-s-3 tw:p-s-2 tw:mb-s-1 tw:text-left; background: transparent; border: 1px solid transparent; @apply tw:rounded-md tw:text-primary tw:cursor-pointer; }
.directory-item:hover { background: var(--bg-hover); }
.directory-item[aria-pressed="true"] { background: var(--accent-soft); }
.directory-item img, .directory-placeholder { @apply tw:w-[48px] tw:h-[60px] tw:shrink-0 tw:rounded-sm tw:object-cover; object-position: center 20%; background: var(--bg-elevated); }
.directory-placeholder { @apply tw:grid; place-items: center; @apply tw:text-accent; }
.directory-label { @apply tw:min-w-0 tw:grid tw:gap-s-1; }
.directory-label strong { @apply tw:text-body-sm tw:font-semibold; }
.directory-label small { @apply tw:text-label-xs tw:text-secondary tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap; }
.directory-current { padding: var(--s-3) var(--s-4); border-top: 1px solid var(--border-soft); }
.directory-empty { padding: var(--s-5) var(--s-3); }
@media (max-width: 900px) { .character-directory { @apply tw:static tw:max-h-[360px]; } }
@media (prefers-reduced-motion: reduce) { .directory-item { transition: none; } }

/* catalog：作品筛选侧栏 + 角色结果区，滚动职责分别归属筛选栏与结果列表。 */
.directory-catalog { @apply tw:static; max-height: none; @apply tw:min-h-0; flex: 1 1 auto; @apply tw:grid; grid-template-columns: minmax(0, 208px) minmax(0, 1fr); @apply tw:gap-s-4; border: 0; background: transparent; }
.directory-rail { border-right: 1px solid var(--border-soft); }
.directory-series { overscroll-behavior: contain; padding: var(--s-1) var(--s-1) var(--s-2); scrollbar-width: thin; scroll-padding-block: var(--s-1); }
.directory-series button, .directory-pagination button { border: 1px solid transparent; @apply tw:rounded-md; padding: var(--s-2) var(--s-3); @apply tw:min-h-[36px] tw:text-secondary; background: var(--bg-deep); font: inherit; @apply tw:text-label tw:cursor-pointer; }
.directory-pagination .studio-select-wrapper { @apply tw:min-h-[36px]; }
.directory-series button { @apply tw:flex tw:items-center tw:justify-between tw:gap-s-2 tw:w-full tw:min-w-0 tw:text-left tw:leading-body; overflow-wrap: anywhere; }
.directory-series button[aria-pressed="true"] { background: var(--accent-soft); @apply tw:text-accent tw:border-accent; }
.directory-series button span { @apply tw:text-muted tw:shrink-0; }
/* 分页行给结果滚动区一个明确的下边界，让「未滚到底」与「被裁切」可区分。 */
.directory-pagination { padding: var(--s-3) 0; border-top: 1px solid var(--border-soft); }
.directory-pagination button:disabled { @apply tw:text-disabled tw:cursor-default; }
.directory-catalog button:focus-visible,
.directory-pagination :deep(.studio-select-trigger):focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.directory-catalog .directory-tools { padding: var(--s-3) 0 0; }
.directory-catalog .directory-list { @apply tw:min-h-0 tw:grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 150px), 1fr)); @apply tw:gap-s-2; padding: var(--s-1) var(--s-1) var(--s-3); align-content: start; }
.directory-catalog .directory-item { @apply tw:relative tw:flex tw:flex-col tw:items-stretch tw:gap-s-3 tw:m-0 tw:min-w-0 tw:p-s-2; background: var(--bg-surface); @apply tw:rounded-lg; }
.directory-catalog .directory-item :deep(.character-portrait) { @apply tw:w-full tw:h-[170px]; border: 0; @apply tw:rounded-md; background: var(--bg-elevated); }
.directory-catalog .directory-item :deep(.character-portrait img) { transform: none; object-position: center 20%; }
.directory-catalog .directory-label { padding: 0 var(--s-1) var(--s-2); }
.directory-catalog .directory-label small { @apply tw:whitespace-normal tw:leading-body; }
.directory-catalog .directory-selected { @apply tw:absolute tw:top-s-3 tw:right-s-3 tw:grid; place-items: center; @apply tw:w-[28px] tw:h-[28px]; border: 1px solid var(--accent); @apply tw:rounded-pill; background: var(--bg-surface); }
.directory-catalog .directory-item:hover { @apply tw:border-accent; }
.directory-catalog .directory-item[aria-pressed="true"] { background: var(--accent-soft); @apply tw:border-accent; }
.directory-catalog .directory-label strong { overflow-wrap: anywhere; @apply tw:leading-body; }
.directory-catalog .directory-empty { grid-column: 1 / -1; }
.directory-catalog .directory-current { padding-inline: 0; }
/* 窄屏：作品筛选折叠成单行横向条，不再用固定高度裁掉第三行。 */
@media (max-width: 900px) {
  .directory-catalog { @apply tw:flex tw:flex-col tw:gap-s-3; }
  /* 筛选条按内容取高，不参与纵向收缩，否则会被结果区挤成只有几像素高的裁切条。 */
  .directory-rail { flex: 0 0 auto; padding: 0 0 var(--s-2); border-right: 0; border-bottom: 1px solid var(--border-soft); }
  .directory-rail-title { @apply tw:mb-s-1; }
  .directory-series { flex: 0 0 auto; @apply tw:flex-row tw:flex-nowrap tw:min-h-[44px] tw:overflow-x-auto tw:overflow-y-hidden; padding: var(--s-1) 0 var(--s-2); }
  .directory-series button { flex: 0 0 auto; @apply tw:w-auto tw:whitespace-nowrap; }
}
@media (max-width: 540px) { .directory-catalog .directory-list { grid-template-columns: repeat(2, minmax(0, 1fr)); } .directory-catalog .directory-item :deep(.character-portrait) { @apply tw:h-[138px]; } }
</style>
