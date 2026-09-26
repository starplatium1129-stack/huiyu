<template>
  <aside class="character-directory" :class="{ 'directory-catalog': catalog }" aria-label="角色目录">
    <!-- 作品筛选：宽屏独立侧栏，窄屏折叠为单行横向筛选，始终只有一个纵向滚动区 -->
    <div v-if="catalog" class="directory-rail">
      <p class="directory-rail-title">按作品筛选</p>
      <div ref="rail" class="directory-series" role="group" aria-label="按作品浏览" @keydown="onRailKeys">
        <button type="button" :aria-pressed="!series" @click="series = ''">全部作品</button>
        <button v-for="group in groups" :key="group.key" type="button"
          :aria-pressed="series === group.key" @click="series = group.key">{{ group.label }} <span>{{ group.count }}</span></button>
      </div>
    </div>
    <div class="directory-main">
      <div class="directory-tools">
        <label class="directory-heading" :for="inputId">选择角色 <span v-if="!catalog">{{ items.length }}</span></label>
        <input :id="inputId" v-model="query" type="search" aria-label="搜索角色或作品" placeholder="角色名、作品或别名…" :autofocus="catalog" @keydown="onSearchKeydown" />
        <StudioSelect v-if="!catalog" v-model="series" label="筛选角色系列" :options="[{ value: '', label: '全部系列' }, ...groups.map(group => ({ value: group.key, label: `${group.label} · ${group.count}` }))]" />
        <div class="directory-count"><span role="status">找到 {{ results.length }} 位角色</span><button v-if="query || series" type="button" @click="query = ''; series = ''">清除筛选</button></div>
      </div>
      <div ref="list" class="directory-list" role="group" aria-label="角色列表" @keydown.down.prevent="move(1)" @keydown.up.prevent="move(-1)">
        <button v-for="item in visibleResults" :key="item.id" type="button" class="directory-item" :data-character="item.id" :aria-pressed="selectedId === item.id" @click="emit('select', item.id)">
          <CharacterPortrait :src="resolveRuntimeUrl(item.image)" :name="item.name" />
          <span class="directory-label">
            <strong>{{ item.name }}</strong>
            <StudioTooltip :content="franchiseLabel(franchiseKey(item.source))">
              <small>{{ franchiseLabel(franchiseKey(item.source)) }}</small>
            </StudioTooltip>
          </span>
          <span v-if="selectedId === item.id" class="directory-selected" aria-hidden="true"><ArchiveIcon name="success" /></span>
        </button>
        <div v-if="!results.length" class="directory-empty">没有匹配的角色。<br />试试其他名字，或清除筛选。</div>
      </div>
      <nav v-if="pageCount > 1" class="directory-pagination" aria-label="角色分页">
        <button type="button" :disabled="page === 1" @click="page--">上一页</button>
        <label>第 <StudioSelect v-model.number="page" label="跳转角色页" inline size="sm" :options="pageItems.map(n => ({ value: n, label: String(n) }))" /> / {{ pageCount }} 页</label>
        <button type="button" :disabled="page === pageCount" @click="page++">下一页</button>
      </nav>
      <div class="directory-current"><span>当前：{{ selected?.name || '未选择' }}</span><button v-if="selected" type="button" @click="locateSelected">定位</button></div>
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
function move(step: number) { moveIn(list.value, step) }
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
.character-directory { position: sticky; top: 82px; display: flex; flex-direction: column; max-height: max(360px, calc(100dvh - 280px)); border: 1px solid var(--border-soft); border-radius: var(--r-xl); background: var(--bg-surface); overflow: hidden; }
.directory-main { display: flex; flex-direction: column; min-height: 0; flex: 1 1 auto; }
.directory-tools { padding: var(--s-4); display: grid; gap: var(--s-3); flex-shrink: 0; }
.directory-heading { display: flex; justify-content: space-between; font-size: var(--fs-body-sm); font-weight: 600; }
.directory-heading span, .directory-count { color: var(--text-muted); font-size: var(--fs-label-xs); }
.directory-tools input { min-width: 0; width: 100%; min-height: 40px; padding: var(--s-2) var(--s-3); color: var(--text-primary); background: var(--bg-deep); border: 1px solid var(--border-soft); border-radius: var(--r-md); font: inherit; font-size: var(--fs-label); }
/* 原生 <select> 已迁移为 StudioSelect：外观由组件统一提供；布局（宽度）落在 wrapper。 */
.directory-tools .studio-select-wrapper { width: 100%; min-width: 0; min-height: 40px; }
.directory-count, .directory-current { display: flex; justify-content: space-between; align-items: center; gap: var(--s-2); }
.directory-count button, .directory-current button { padding: 0; border: 0; background: transparent; color: var(--accent); cursor: pointer; font: inherit; }
.directory-list { flex: 1 1 auto; min-height: 120px; overflow-y: auto; overscroll-behavior: contain; padding: 0 var(--s-2) var(--s-2); scrollbar-width: thin; scroll-padding-block: var(--s-2); }
.directory-item { width: 100%; display: flex; align-items: center; gap: var(--s-3); padding: var(--s-2); margin-bottom: var(--s-1); text-align: left; background: transparent; border: 1px solid transparent; border-radius: var(--r-md); color: var(--text-primary); cursor: pointer; transition: transform var(--motion-hover); }
.directory-item:hover { background: var(--bg-hover); }
.directory-item[aria-pressed="true"] { background: var(--accent-soft); border-color: var(--accent); }
.directory-item:active { transform: scale(.985); }
.directory-item img, .directory-placeholder { width: 48px; height: 60px; flex-shrink: 0; border-radius: var(--r-sm); object-fit: cover; object-position: center 20%; background: var(--bg-elevated); }
.directory-placeholder { display: grid; place-items: center; color: var(--accent); }
.directory-label { min-width: 0; display: grid; gap: var(--s-1); }
.directory-label strong { font-size: var(--fs-body-sm); font-weight: 600; }
.directory-label small { font-size: var(--fs-label-xs); color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.directory-selected { margin-left: auto; color: var(--accent); }
.directory-current { padding: var(--s-3) var(--s-4); border-top: 1px solid var(--border-soft); font-size: var(--fs-label-xs); color: var(--text-secondary); flex-shrink: 0; }
.directory-empty { padding: var(--s-5) var(--s-3); color: var(--text-muted); font-size: var(--fs-label); }
@media (max-width: 900px) { .character-directory { position: static; max-height: 360px; } }
@media (prefers-reduced-motion: reduce) { .directory-item { transition: none; } }

/* catalog：作品筛选侧栏 + 角色结果区，滚动职责分别归属筛选栏与结果列表。 */
.directory-catalog { position: static; max-height: none; min-height: 0; flex: 1 1 auto; display: grid; grid-template-columns: minmax(0, 208px) minmax(0, 1fr); gap: var(--s-4); border: 0; background: transparent; }
.directory-rail { display: flex; flex-direction: column; gap: var(--s-2); min-width: 0; min-height: 0; padding-right: var(--s-3); border-right: 1px solid var(--border-soft); }
.directory-rail-title { margin: 0; color: var(--text-muted); font-size: var(--fs-label-xs); font-weight: 600; }
.directory-series { display: flex; flex-direction: column; gap: var(--s-1); min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: var(--s-1) var(--s-1) var(--s-2); scrollbar-width: thin; scroll-padding-block: var(--s-1); }
.directory-series button, .directory-pagination button { border: 1px solid var(--border-soft); border-radius: var(--r-md); padding: var(--s-2) var(--s-3); min-height: 36px; color: var(--text-secondary); background: var(--bg-deep); font: inherit; font-size: var(--fs-label); cursor: pointer; }
.directory-pagination .studio-select-wrapper { min-height: 36px; }
.directory-series button { display: flex; align-items: center; justify-content: space-between; gap: var(--s-2); width: 100%; min-width: 0; text-align: left; line-height: var(--lh-body); overflow-wrap: anywhere; }
.directory-series button[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent); border-color: var(--accent); }
.directory-series button span { color: var(--text-muted); flex-shrink: 0; }
/* 分页行给结果滚动区一个明确的下边界，让「未滚到底」与「被裁切」可区分。 */
.directory-pagination { display: flex; justify-content: space-between; align-items: center; gap: var(--s-2); padding: var(--s-3) 0; margin-top: var(--s-2); border-top: 1px solid var(--border-soft); color: var(--text-secondary); font-size: var(--fs-label); flex-shrink: 0; }
.directory-pagination button:disabled { color: var(--text-disabled); cursor: default; }
.directory-catalog button:focus-visible,
.directory-pagination :deep(.studio-select-trigger):focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.directory-catalog .directory-tools { padding: var(--s-3) 0 0; }
.directory-catalog .directory-list { min-height: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 150px), 1fr)); gap: var(--s-2); padding: var(--s-1) var(--s-1) var(--s-3); align-content: start; }
.directory-catalog .directory-item { position: relative; display: flex; flex-direction: column; align-items: stretch; gap: var(--s-3); margin: 0; min-width: 0; padding: var(--s-2); background: var(--bg-surface); border-color: var(--border-soft); border-radius: var(--r-lg); }
.directory-catalog .directory-item :deep(.character-portrait) { width: 100%; height: 170px; border: 0; border-radius: var(--r-md); background: var(--bg-elevated); }
.directory-catalog .directory-item :deep(.character-portrait img) { transform: none; object-position: center 20%; }
.directory-catalog .directory-label { padding: 0 var(--s-1) var(--s-2); }
.directory-catalog .directory-label small { white-space: normal; line-height: var(--lh-body); }
.directory-catalog .directory-selected { position: absolute; top: var(--s-3); right: var(--s-3); display: grid; place-items: center; width: 28px; height: 28px; border: 1px solid var(--accent); border-radius: var(--r-pill); background: var(--bg-surface); }
.directory-catalog .directory-item:hover { border-color: var(--accent); transform: translateY(-2px); }
.directory-catalog .directory-item[aria-pressed="true"] { background: var(--accent-soft); border-color: var(--accent); }
.directory-catalog .directory-label strong { overflow-wrap: anywhere; line-height: var(--lh-body); }
.directory-catalog .directory-empty { grid-column: 1 / -1; }
.directory-catalog .directory-current { padding-inline: 0; }
/* 窄屏：作品筛选折叠成单行横向条，不再用固定高度裁掉第三行。 */
@media (max-width: 900px) {
  .directory-catalog { display: flex; flex-direction: column; gap: var(--s-3); }
  /* 筛选条按内容取高，不参与纵向收缩，否则会被结果区挤成只有几像素高的裁切条。 */
  .directory-rail { flex: 0 0 auto; padding: 0 0 var(--s-2); border-right: 0; border-bottom: 1px solid var(--border-soft); }
  .directory-rail-title { margin-bottom: var(--s-1); }
  .directory-series { flex: 0 0 auto; flex-direction: row; flex-wrap: nowrap; min-height: 44px; overflow-x: auto; overflow-y: hidden; padding: var(--s-1) 0 var(--s-2); }
  .directory-series button { flex: 0 0 auto; width: auto; white-space: nowrap; }
}
@media (max-width: 540px) { .directory-catalog .directory-list { grid-template-columns: repeat(2, minmax(0, 1fr)); } .directory-catalog .directory-item :deep(.character-portrait) { height: 138px; } }
</style>
