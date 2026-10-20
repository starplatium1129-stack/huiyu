<template>
  <Teleport to="body">
    <Transition :css="false" @enter="searchMotion.enter" @leave="searchMotion.leave" @after-leave="searchMotion.dispose">
    <div v-show="open" class="global-search" :inert="!open" @pointerdown.self="close()">
      <ListboxRoot ref="listbox" as-child highlight-on-hover :model-value="''" @highlight="activeKey = typeof $event?.value === 'string' ? $event.value : undefined" @update:model-value="run">
      <div ref="panelEl" class="gs-panel" :data-trigger="triggerSource" role="dialog" aria-modal="true" aria-label="全局搜索">
        <div class="gs-heading tw:flex tw:items-center tw:justify-between tw:gap-s-3 tw:text-primary tw:text-body-sm"><strong>快速查找</strong><span>角色、场景与作品</span></div>
        <div class="gs-input-row tw:flex tw:items-center tw:gap-s-3">
          <StudioSearch v-model="query" class="gs-search" label="搜索角色、服装、场景、蓝图、作品或页面" placeholder="搜索角色、服装、场景、蓝图…" :clear-on-escape="false">
            <template #input="{ inputProps }">
              <ListboxFilter v-model="query" as-child>
                <input ref="inputEl" v-bind="inputProps" role="combobox" aria-haspopup="listbox" :aria-expanded="open"
                  :aria-controls="listboxId" aria-autocomplete="list" :aria-describedby="searchAnnouncementId" />
              </ListboxFilter>
            </template>
          </StudioSearch>
          <StudioTooltip content="关闭搜索（Esc）">
            <button type="button" class="btn btn-ghost btn-icon gs-esc" aria-label="关闭搜索" @click="close()"><ArchiveIcon name="close" /></button>
          </StudioTooltip>
        </div>
        <div v-if="scenesLoading || scenesError" class="gs-catalog-state">
          <p :role="scenesError ? 'alert' : 'status'">{{ scenesError || '正在读取内容目录…' }}</p>
          <button v-if="scenesError" type="button" class="btn btn-ghost btn-sm" @click="retryScenes">重新读取目录</button>
        </div>
        <ListboxContent as-child>
        <div :id="listboxId" ref="resultsEl" class="gs-results tw:overflow-y-auto tw:p-s-3" aria-label="搜索结果">
          <ListboxGroup v-for="group in resultGroups" :key="group.id" class="gs-group tw:mb-s-2">
            <ListboxGroupLabel as="h4" class="gs-group-title tw:text-muted tw:text-label-sm tw:font-semibold">{{ group.label }}</ListboxGroupLabel>
            <ListboxItem v-for="item in group.items" :key="item.key" :value="item.key" as="button" type="button"
              class="gs-row tw:flex tw:items-center tw:gap-s-3 tw:w-full tw:min-h-[46px] tw:rounded-md tw:text-primary tw:text-left tw:cursor-pointer">
              <ArchiveIcon :name="item.icon" /><span>{{ item.label }}</span><small v-if="item.meta">{{ item.meta }}</small>
            </ListboxItem>
          </ListboxGroup>
          <template v-if="query.trim()">
            <p v-if="worksError" class="gs-empty tw:text-muted tw:text-center tw:text-body-sm" role="alert">{{ worksError }}</p>
            <p v-else-if="worksLoading" class="gs-empty tw:text-muted tw:text-center tw:text-body-sm" role="status">正在读取作品…</p>
            <p v-if="!scenesLoading && !scenesError && !worksError && !worksLoading && !flat.length" class="gs-empty tw:text-muted tw:text-center tw:text-body-sm">
              没有匹配的结果，试试角色、服装、场景标题或作品名。
            </p>
          </template>
        </div>
        </ListboxContent>
        <p :id="searchAnnouncementId" class="gs-sr-status tw:absolute tw:w-[1px] tw:h-[1px] tw:p-0 tw:m-[-1px] tw:overflow-hidden tw:whitespace-nowrap" role="status" aria-live="polite" aria-atomic="true">{{ resultsAnnouncement }}</p>
        <div class="gs-footer tw:flex tw:justify-between tw:gap-s-3 tw:text-muted tw:text-label-sm" aria-hidden="true"><span>↑ ↓ 选择 · Enter 打开</span><span>Esc 关闭</span></div>
      </div>
      </ListboxRoot>
    </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, useId, watch } from 'vue'
import { ListboxRoot, ListboxFilter, ListboxContent, ListboxGroup, ListboxGroupLabel, ListboxItem } from 'reka-ui'
import StudioSearch from '@/components/ui/StudioSearch.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import { useFluidSurface } from '@/composables/useFluidSurface'
import { useGlobalSearchPanel } from '@/composables/useGlobalSearchPanel'
import { useGlobalSearchResults } from '@/composables/useGlobalSearchResults'

const props = defineProps<{
  initialSource?: 'keyboard' | 'pointer'
  initialTrigger?: HTMLElement | null
  initialPath?: string
  initialCloseRequest: number
}>()

const activeKey = ref<string>()
const listbox = ref<{ highlightFirstItem: () => void; highlightedElement: HTMLElement | null } | null>(null)
const inputEl = ref<HTMLInputElement | null>(null), panelEl = ref<HTMLElement | null>(null)
const resultsEl = ref<HTMLElement | null>(null)
const searchMotion = useFluidSurface('.gs-panel', { animatePanel: true, small: true })
const { open, query, triggerSource, close, navigate } = useGlobalSearchPanel({ panelEl, inputEl, initial: props })
const { queryTerms, resultGroups, flat, scenesLoading, scenesError, worksLoading, worksError, retryScenes: reloadScenes } = useGlobalSearchResults(open, query)
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
    ? `找到 ${total} 个结果，当前第 ${activeIndex.value + 1} 项：${result.label}`
    : `找到 ${total} 个结果`
  return [message, status].filter(Boolean).join('；')
})

function run(key: unknown) {
  const item = flat.value.find(result => result.key === key)
  if (item) return navigate(item)
}
function retryScenes(event: MouseEvent) {
  if (document.activeElement === event.currentTarget) inputEl.value?.focus({ preventScroll: true })
  reloadScenes()
}

watch([query, open], () => {
  if (!open.value) return
  activeKey.value = undefined
  // Opening and query changes restart selection at the first result.
  void nextTick(() => {
    if (!open.value) return
    listbox.value?.highlightFirstItem()
    resultsEl.value?.scrollTo({ top: 0, behavior: 'instant' })
  })
})

// Async catalog updates preserve the highlighted record, never its old array index.
watch(flat, () => {
  if (!open.value || listbox.value?.highlightedElement?.isConnected && activeResult.value) return
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
  -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
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
  padding: var(--s-4) var(--s-5);
  background: var(--bg-base);
  border-bottom: 1px solid var(--border-soft);
}
.gs-search { flex:1; min-width:0; }
.gs-heading { padding:var(--s-3) var(--s-5); }
.gs-heading span { @apply tw:text-secondary tw:text-label-xs; }
.gs-catalog-state { display:flex; align-items:center; gap:var(--s-3); flex-shrink:0; padding:var(--s-2) var(--s-5); border-bottom:1px solid var(--border-soft); }
.gs-catalog-state p { flex:1; min-width:0; margin:0; color:var(--text-secondary); font-size:var(--fs-label-xs); line-height:var(--lh-body); overflow-wrap:anywhere; }
.gs-catalog-state button { flex:none; }
.gs-esc { flex:0 0 auto; }
.gs-heading, .gs-input-row, .gs-footer { flex-shrink:0; }
.gs-results { min-height:0; flex:1 1 auto; max-height: min(52vh, 480px); overscroll-behavior:contain; scroll-padding-block:var(--s-2); }
.gs-group-title {
  margin: var(--s-2) var(--s-2) var(--s-1);
}
.gs-row { padding: var(--s-2) var(--s-3);
  border: 0;
  background: transparent;
  font: inherit;
}
.gs-row > .archive-icon { width:16px; height:16px; flex-shrink:0; }
.gs-row > span { flex:1; min-width:0; overflow-wrap:anywhere; }
.gs-row small { @apply tw:min-w-0 tw:ml-auto tw:text-muted tw:text-label-sm tw:whitespace-nowrap tw:overflow-hidden tw:text-ellipsis tw:max-w-[46%]; }
.gs-row[data-highlighted] { background: var(--bg-hover); @apply tw:text-primary; }
.gs-row[data-highlighted] small { @apply tw:text-secondary; }
.gs-footer { padding: var(--s-3) var(--s-5); border-top: 1px solid var(--border-soft); background: var(--bg-surface); }
.gs-sr-status { clip: rect(0 0 0 0); clip-path: inset(50%); border: 0; }
@media (max-width:600px) { .global-search { --search-inset:var(--s-5); } .gs-results { @apply tw:max-h-[60dvh]; } }
.gs-empty { padding: var(--s-6) var(--s-4); }
@media (forced-colors:active) { .gs-row[data-highlighted] { outline:2px solid Highlight; outline-offset:-2px; } }
</style>
