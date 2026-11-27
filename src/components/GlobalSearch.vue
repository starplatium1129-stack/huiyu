<template>
  <Teleport to="body">
    <Transition :css="false" @enter="searchMotion.enter" @leave="searchMotion.leave" @after-leave="searchMotion.dispose">
    <div v-show="open" class="global-search" :inert="!open" @pointerdown.self="close()">
      <ListboxRoot ref="listbox" as-child highlight-on-hover :model-value="''" @highlight="activeKey = typeof $event?.value === 'string' ? $event.value : undefined" @update:model-value="run">
      <div ref="panelEl" class="gs-panel" :data-trigger="triggerSource" role="dialog" aria-modal="true" aria-label="全局搜索" @keydown.capture="recordSelectionKey">
        <header class="gs-heading">
          <h2>全局搜索</h2>
          <StudioTooltip content="关闭搜索（Esc）">
            <button type="button" class="btn btn-quiet btn-icon" aria-label="关闭搜索" @click="close()"><ArchiveIcon name="close" /></button>
          </StudioTooltip>
        </header>
        <div class="gs-input-row">
          <StudioSearch v-model="query" class="gs-search" label="搜索角色、服装、场景、蓝图、作品或页面" placeholder="搜索角色、场景、作品或页面…" :clear-on-escape="false">
            <template #input="{ inputProps }">
              <ListboxFilter v-model="query" as-child>
                <input ref="inputEl" v-bind="inputProps" role="combobox" aria-haspopup="listbox" :aria-expanded="open"
                  :aria-controls="listboxId" aria-autocomplete="list" :aria-describedby="searchAnnouncementId" />
              </ListboxFilter>
            </template>
          </StudioSearch>
        </div>
        <div v-if="scenesLoading || scenesError" class="gs-catalog-state">
          <p :role="scenesError ? 'alert' : 'status'">{{ scenesError || '正在读取内容目录…' }}</p>
          <button v-if="scenesError" type="button" class="btn btn-ghost btn-sm" @click="retrySearch(retryScenes, $event)">重新读取目录</button>
        </div>
        <div ref="resultsEl" class="gs-results tw:overflow-y-auto tw:p-s-3">
          <ListboxContent :id="listboxId" aria-label="搜索结果">
            <ListboxGroup v-for="group in resultGroups" :key="group.id" class="gs-group tw:mb-s-2">
              <ListboxGroupLabel as="h3" class="gs-group-title tw:text-muted tw:text-label-sm tw:font-semibold">{{ group.label }}</ListboxGroupLabel>
              <ListboxItem v-for="item in group.items" :key="item.key" :value="item.key" as="button" type="button"
                class="gs-row tw:flex tw:items-center tw:gap-s-3 tw:w-full tw:min-h-[46px] tw:rounded-md tw:text-primary tw:text-left tw:cursor-pointer" @pointermove="selectionTouched = true">
                <span class="gs-row-icon" aria-hidden="true"><ArchiveIcon :name="item.icon" /></span>
                <span class="gs-row-label">{{ item.label }}</span><small v-if="item.meta">{{ item.meta }}</small>
              </ListboxItem>
            </ListboxGroup>
          </ListboxContent>
          <template v-if="query.trim()">
            <div v-if="worksError" class="gs-catalog-state">
              <p role="alert">{{ worksError }}</p>
              <button type="button" class="btn btn-ghost btn-sm" @click="retrySearch(retryWorks, $event)">重新读取作品</button>
            </div>
            <p v-else-if="worksLoading" class="gs-empty tw:text-muted tw:text-center tw:text-body-sm" role="status">正在读取作品…</p>
            <div v-if="!scenesLoading && !scenesError && !worksError && !worksLoading && !flat.length" class="gs-empty tw:text-center tw:py-s-3">
              <p class="tw:text-muted tw:text-body-sm tw:mb-s-3">未找到匹配结果</p>
              <div class="tw:flex tw:justify-center tw:gap-s-2">
                <button type="button" class="btn btn-ghost btn-sm" @click="clearQuery">清空</button>
                <RouterLink to="/scene-explorer" class="btn btn-primary btn-sm" @click="close">浏览场景</RouterLink>
              </div>
            </div>
          </template>
        </div>
        <div v-if="moreCatalogGroups.length" class="gs-more" aria-label="更多目录结果">
          <button v-for="group in moreCatalogGroups" :key="group.id" type="button" class="btn btn-quiet btn-sm"
            :aria-disabled="group.loadingMore" @click="showMore(group.id, $event)">
            {{ group.loadingMore ? '正在读取…' : `更多${group.name} (+${group.total - group.items.length})` }}
          </button>
        </div>
        <p :id="searchAnnouncementId" class="gs-sr-status tw:absolute tw:w-[1px] tw:h-[1px] tw:p-0 tw:m-[-1px] tw:overflow-hidden tw:whitespace-nowrap" role="status" aria-live="polite" aria-atomic="true">{{ resultsAnnouncement }}</p>
        <div class="gs-footer" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd>选择</span>
          <span><kbd>Enter</kbd>打开</span>
          <span><kbd>Esc</kbd>关闭</span>
        </div>
      </div>
      </ListboxRoot>
    </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, useId, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { ListboxRoot, ListboxFilter, ListboxContent, ListboxGroup, ListboxGroupLabel, ListboxItem } from 'reka-ui'
import StudioSearch from '@/components/ui/StudioSearch.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import { useFluidSurface } from '@/composables/useFluidSurface'
import { useGlobalSearchPanel } from '@/composables/useGlobalSearchPanel'
import { useGlobalSearchResults } from '@/composables/useGlobalSearchResults'
import type { SearchCatalogKind } from '@/composables/useCatalogSearch'

const props = defineProps<{
  initialSource?: 'keyboard' | 'pointer'
  initialTrigger?: HTMLElement | null
  initialPath?: string
  initialCloseRequest: number
}>()

const activeKey = ref<string>()
const selectionTouched = ref(false)
const listbox = ref<{ highlightFirstItem: () => void; highlightedElement: HTMLElement | null } | null>(null)
const inputEl = ref<HTMLInputElement | null>(null), panelEl = ref<HTMLElement | null>(null)
const resultsEl = ref<HTMLElement | null>(null)
const searchMotion = useFluidSurface('.gs-panel', { animatePanel: true, small: true })
const { open, query, triggerSource, close, navigate } = useGlobalSearchPanel({ panelEl, inputEl, initial: props })
const { queryTerms, resultGroups, flat, moreCatalogGroups, loadMoreCatalog, scenesLoading, scenesError, worksLoading, worksError, retryScenes, retryWorks } = useGlobalSearchResults(open, query)
const searchInstanceId = useId()
const listboxId = `global-search-listbox-${searchInstanceId}`
const searchAnnouncementId = `global-search-announcement-${searchInstanceId}`

const activeIndex = computed(() => flat.value.findIndex(item => item.key === activeKey.value))
const activeResult = computed(() => flat.value[activeIndex.value])
const resultsAnnouncement = computed(() => {
  const total = flat.value.length
  const result = activeResult.value
  const status = [scenesLoading.value ? '内容目录读取中' : scenesError.value,
    queryTerms.value.length ? worksLoading.value ? '作品读取中' : worksError.value : ''].filter(Boolean).join('；')
  const message = !total ? status ? '当前暂无结果' : query.value.trim() ? '没有匹配的结果' : '暂无可用结果' : result
    ? `已显示 ${total} 个结果，当前第 ${activeIndex.value + 1} 项：${result.label}`
    : `已显示 ${total} 个结果`
  return [message, status].filter(Boolean).join('；')
})

function run(key: unknown) {
  const item = flat.value.find(result => result.key === key)
  if (item) return navigate(item)
}
function clearQuery() {
  query.value = ''
  inputEl.value?.focus({ preventScroll: true })
}
function retrySearch(retry: () => void, event: MouseEvent) {
  if (document.activeElement === event.currentTarget) inputEl.value?.focus({ preventScroll: true })
  retry()
}
function recordSelectionKey(event: KeyboardEvent) {
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) selectionTouched.value = true
}
async function showMore(kind: SearchCatalogKind, event: MouseEvent) {
  const button = event.currentTarget as HTMLElement
  selectionTouched.value = true
  await loadMoreCatalog(kind)
  await nextTick()
  if (open.value && !button.isConnected && document.activeElement === document.body) inputEl.value?.focus({ preventScroll: true })
}

watch([query, open], () => {
  if (!open.value) return
  activeKey.value = undefined
  selectionTouched.value = false
  // Opening and query changes restart selection at the first result.
  void nextTick(() => {
    if (!open.value) return
    listbox.value?.highlightFirstItem()
    resultsEl.value?.scrollTo({ top: 0, behavior: 'instant' })
  })
})

// Preserve an explicit selection; otherwise highlight the best result after async reads.
watch(flat, () => {
  if (!open.value || selectionTouched.value && listbox.value?.highlightedElement?.isConnected && activeResult.value) return
  activeKey.value = undefined
  listbox.value?.highlightFirstItem()
}, { flush: 'post' })

</script>

<style scoped>
@reference "../assets/css/tailwind.css";
.global-search {
  --search-inset: clamp(var(--s-4), 10dvh, 96px);
  @apply tw:fixed; inset: 0; z-index: var(--z-overlay);
  @apply tw:flex tw:items-start tw:justify-center;
  padding: var(--search-inset) var(--s-4);
  padding-top:calc(var(--desktop-chrome-height,0px) + var(--search-inset));
  background: color-mix(in srgb, var(--art-backdrop) 72%, transparent);
  -webkit-backdrop-filter: var(--glass-disabled, blur(8px)); backdrop-filter: var(--glass-disabled, blur(8px));
}
.gs-panel {
  --surface-enter-y:14px; --surface-enter-scale:.94; transform-origin:center top;
  width: min(640px, 96vw);
  max-height:calc(100dvh - var(--desktop-chrome-height,0px) - 2 * var(--search-inset));
  display: flex;
  flex-direction: column;
  border: 1px solid var(--glass-edge);
  @apply tw:rounded-xl;
  background: var(--bg-surface);
  box-shadow: var(--shadow-glass-elevated);
  @apply tw:overflow-hidden;
}
.gs-input-row {
  padding: var(--s-2) var(--s-5) var(--s-4);
  border-bottom: 1px solid var(--border-soft);
}
.gs-search { min-height:48px; background:var(--bg-base); }
.gs-heading { display:flex; align-items:center; justify-content:space-between; gap:var(--s-3); padding:var(--s-3) var(--s-5) 0; }
.gs-heading h2 { margin:0; color:var(--text-primary); font:500 var(--fs-title-sm)/var(--lh-label) var(--font-serif); }
.gs-catalog-state { display:flex; align-items:center; gap:var(--s-3); flex-shrink:0; padding:var(--s-2) var(--s-5); border-bottom:1px solid var(--border-soft); }
.gs-catalog-state p { flex:1; min-width:0; margin:0; color:var(--text-secondary); font-size:var(--fs-label-xs); line-height:var(--lh-body); overflow-wrap:anywhere; }
.gs-catalog-state button { flex:none; }
.gs-more { display:flex; flex-wrap:wrap; gap:var(--s-1); padding:var(--s-2) var(--s-4); border-top:1px solid var(--border-soft); }
.gs-heading, .gs-input-row, .gs-footer { flex-shrink:0; }
.gs-results { min-height:0; flex:1 1 auto; max-height:min(52dvh,480px); overscroll-behavior:contain; scroll-padding-block:var(--s-2); }
.gs-group-title {
  display:flex;
  align-items:center;
  gap:var(--s-3);
  margin:var(--s-2) var(--s-3) var(--s-1);
}
.gs-group-title::after { content:''; flex:1; height:1px; background:var(--border-soft); }
.gs-row { position:relative; padding: var(--s-1) var(--s-3);
  border: 0;
  background: transparent;
  font: inherit;
}
.gs-row-icon { display:grid; place-items:center; flex:none; width:30px; height:30px; color:var(--text-secondary); }
.gs-row-icon .archive-icon { width:18px; height:18px; }
.gs-row-label { flex:1; min-width:0; overflow-wrap:anywhere; }
.gs-row small { @apply tw:min-w-0 tw:ml-auto tw:text-muted tw:text-label-sm tw:whitespace-nowrap tw:overflow-hidden tw:text-ellipsis tw:max-w-[46%]; }
.gs-row[data-highlighted] { background:var(--bg-elevated); }
.gs-row[data-highlighted]::before { content:''; position:absolute; inset-inline-start:0; width:3px; height:18px; border-radius:var(--r-pill); background:var(--text-primary); }
.gs-row[data-highlighted] .gs-row-icon { color:var(--text-primary); }
.gs-row[data-highlighted] small { @apply tw:text-secondary; }
.gs-footer { display:flex; flex-wrap:wrap; align-items:center; gap:var(--s-4); padding:var(--s-3) var(--s-5); border-top:1px solid var(--border-soft); background:var(--bg-base); color:var(--text-secondary); font-size:var(--fs-label-sm); }
.gs-footer span { display:inline-flex; align-items:center; gap:var(--s-1); }
.gs-footer span:last-child { margin-inline-start:auto; }
.gs-sr-status { clip: rect(0 0 0 0); clip-path: inset(50%); border: 0; }
@media (max-width:600px) { .global-search { --search-inset:var(--s-5); } .gs-results { @apply tw:max-h-[60dvh]; } }
@media (max-height:520px) {
  .global-search { --search-inset:var(--s-2); padding-inline:var(--s-2); }
  .gs-panel { width:min(640px,100%); }
  .gs-results { max-height:none; }
  .gs-heading { padding:var(--s-2) var(--s-3) 0; }
  .gs-input-row { padding:var(--s-2) var(--s-3); }
  .gs-footer { display:none; }
}
.gs-empty { padding: var(--s-6) var(--s-4); }
@media (forced-colors:active) { .gs-row[data-highlighted] { outline:2px solid Highlight; outline-offset:-2px; } }
</style>
