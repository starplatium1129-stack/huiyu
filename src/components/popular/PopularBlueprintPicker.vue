<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import type { SceneBlueprint } from '@/utils/popularContent'

const props = defineProps<{
  pool: SceneBlueprint[]
  categories: string[]
  recommended: SceneBlueprint[]
  filtered: SceneBlueprint[]
  category: string
  showAll: boolean
  dataReady: boolean
  loading: boolean
  error: string
  selectedBlueprintId: string
}>()

const emit = defineEmits<{
  'update:category': [value: string]
  'update:showAll': [value: boolean]
  select: [blueprint: SceneBlueprint]
  rotate: []
  toggle: []
  retry: []
}>()
const picker = ref<HTMLElement | null>(null), results = ref<HTMLElement | null>(null)
function retry() {
  results.value?.focus({ preventScroll: true })
  emit('retry')
}
watch([() => props.dataReady, () => props.loading, () => props.error, () => props.pool], async () => {
  const region = results.value, origin = document.activeElement
  if (!(origin instanceof HTMLElement) || !region || !picker.value?.contains(origin)) return
  await nextTick()
  // A catalog refresh can remove the old card. Preserve any newer focus choice.
  if (region === results.value && region.isConnected && document.activeElement === document.body
    && (!origin.getClientRects().length || origin.matches(':disabled'))) region.focus({ preventScroll: true })
})

/** 分类计数从 pool 计算（与选择状态解耦）：全部最左、其余按数量降序、成人固定垫底独立色调。 */
const categoryChips = computed(() => {
  const chips = props.categories
    .filter(name => name !== '全部' && name !== 'all')
    .map(name => {
      const adult = name === '成人'
      return {
        id: name,
        label: name,
        count: props.pool.filter(bp => (bp.adult ? '成人' : bp.category) === name).length,
        adult,
      }
    })
    .filter(chip => chip.count > 0)
  chips.sort((a, b) => (a.adult ? 1 : b.adult ? -1 : b.count - a.count))
  return [{ id: 'all', label: '全部', count: props.pool.length, adult: false }, ...chips]
})
</script>

<template>
  <div ref="picker" class="blueprint-picker tw:contents">
    <div class="blueprint-cats tw:flex tw:gap-[6px] tw:flex-wrap" role="group" aria-label="蓝图分类">
      <button v-for="chip in categoryChips" :key="chip.id"
        type="button" class="blueprint-cat-btn tw:inline-flex tw:items-center tw:gap-[5px] tw:rounded-pill tw:text-secondary tw:cursor-pointer"
        :class="{ active: props.category === chip.id, adult: chip.adult }"
        :aria-pressed="props.category === chip.id"
        :disabled="!props.dataReady || props.loading"
        @click="emit('update:category', chip.id === 'all' ? 'all' : chip.id)">
        {{ chip.label }}<em v-if="chip.count">{{ chip.count }}</em>
      </button>
    </div>
    <div class="blueprint-reco-head tw:flex tw:items-center tw:gap-s-2 tw:flex-wrap tw:mb-s-2 tw:p-s-1 tw:rounded-pill" data-fluid-glass>
      <span v-if="!props.dataReady || props.loading" class="blueprint-reco-note tw:text-mono-sm tw:text-muted">场景建议</span>
      <span v-else class="blueprint-reco-note tw:text-mono-sm tw:text-muted" role="status">{{ props.showAll ? `${props.filtered.length} 个可选场景` : `推荐 ${props.recommended.length} 个场景` }}</span>
      <button type="button" class="btn btn-ghost btn-sm blueprint-reco-btn" :disabled="!props.dataReady || props.loading" @click="emit('toggle')">
        {{ props.showAll ? '收起 · 只看推荐' : '查看全部' }}
      </button>
      <button v-if="!props.showAll" type="button" class="btn btn-ghost btn-sm blueprint-reco-btn" :disabled="!props.dataReady || props.loading" @click="emit('rotate')">换一批</button>
    </div>
    <div ref="results" class="blueprint-results" tabindex="-1" role="region" aria-label="当前角色场景建议" :aria-busy="props.loading || (!props.dataReady && !props.error)">
      <div v-if="props.error" class="blueprint-feedback">
        <ArchiveIcon name="book" aria-hidden="true" />
        <div><strong>场景建议暂未读取</strong><p role="alert">{{ props.error }}</p></div>
        <button class="btn btn-ghost btn-sm" type="button" @click="retry">重新读取场景</button>
      </div>
      <div v-else-if="!props.dataReady || props.loading" class="scene-loading" role="status">正在读取当前角色场景建议…</div>
      <div v-else-if="!props.filtered.length" class="scene-empty" role="status">没有符合条件的场景建议</div>
      <div v-else v-content-motion:right="`${props.category}:${props.showAll}:${props.recommended[0]?.id}`" class="blueprint-list tw:flex tw:flex-col tw:gap-s-2 tw:p-s-1">
        <button v-for="blueprint in (props.showAll ? props.filtered : props.recommended)"
          :key="blueprint.id" type="button" class="blueprint-card tw:flex tw:flex-col tw:gap-s-2 tw:text-left tw:p-s-3 tw:rounded-lg tw:cursor-pointer"
          :class="{ active: props.selectedBlueprintId === blueprint.id }"
          :data-adult="blueprint.adult ? 'true' : 'false'"
          :aria-pressed="props.selectedBlueprintId === blueprint.id"
          @click="emit('select', blueprint)">
          <span class="blueprint-title tw:text-label tw:font-semibold tw:flex tw:items-center tw:gap-[6px]"><ArchiveIcon v-if="props.selectedBlueprintId === blueprint.id" name="success" class="blueprint-check" />{{ blueprint.title }}<span v-if="blueprint.adult" class="scene-rating-tag">R18</span></span>
          <span class="blueprint-desc tw:text-label-xs tw:text-secondary tw:leading-label tw:overflow-hidden">{{ blueprint.description }}</span>
          <span class="blueprint-meta tw:flex tw:gap-s-2 tw:flex-wrap tw:text-mono-xs tw:text-muted">
            <span>{{ blueprint.category }}</span>
            <span>{{ blueprint.location }}</span>
            <span>{{ blueprint.recommendedSize.replace('x', '×') }}</span>
          </span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
@reference "../../assets/css/tailwind.css";
.blueprint-cats {
  margin: var(--s-1) 0 var(--s-2);
}
.blueprint-results { min-width:0; border-radius:var(--r-md); }
.blueprint-results:focus-visible { outline:none; box-shadow:inset 0 0 0 2px var(--focus-color); }
.blueprint-feedback { display:grid; justify-items:start; gap:var(--s-3); padding:var(--s-4); border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--bg-surface); color:var(--text-primary); overflow-wrap:anywhere; }
.blueprint-feedback > .archive-icon { width:24px; height:24px; color:var(--accent); }
.blueprint-feedback strong { font-size:var(--fs-label); }
.blueprint-feedback p { margin:var(--s-2) 0 0; color:var(--text-secondary); font-size:var(--fs-label-sm); line-height:var(--lh-body); }
.blueprint-cat-btn {
  padding: 3px var(--s-3);
  border: 1px solid var(--border-soft);
  background: var(--glass-fill);
  font: 650 var(--fs-label-sm) var(--font-sans);
  transition: border-color var(--motion-hover), color var(--motion-hover), background var(--motion-hover), transform var(--motion-hover) var(--ease-out);
}
.blueprint-cat-btn:active:not(:disabled) { transform: translateY(1px) scale(.96); }
.blueprint-cat-btn em { @apply tw:not-italic; font: 700 var(--fs-mono-xs) var(--font-mono); @apply tw:text-muted; }
.blueprint-cat-btn:hover:not(:disabled) { border-color: color-mix(in srgb, var(--accent) 45%, var(--border-soft)); @apply tw:text-primary; }
.blueprint-cat-btn:focus-visible { outline: none; box-shadow: var(--focus-shadow); }
.blueprint-cat-btn.active {
  border-color: var(--border-strong);
  background: color-mix(in srgb, var(--mood-love) 18%, var(--bg-elevated));
  @apply tw:text-accent;
}
.blueprint-cat-btn.adult { border-color: color-mix(in srgb, var(--danger-text) 40%, var(--border-soft)); }
.blueprint-cat-btn.adult em { @apply tw:text-danger-text; opacity: .9; }
.blueprint-cat-btn.adult:hover:not(:disabled),
.blueprint-cat-btn.adult.active {
  @apply tw:border-danger-text;
  background: var(--bg-elevated);
  @apply tw:text-danger-text;
}
.blueprint-reco-btn {
  min-height:var(--control-height-sm);
  background:transparent;
  transition: border-color var(--motion-hover), color var(--motion-hover), transform var(--motion-hover) var(--ease-out);
}
.blueprint-reco-btn:hover:not(:disabled) { @apply tw:border-accent tw:text-accent; }
.blueprint-reco-btn:focus-visible { outline: none; box-shadow: var(--focus-shadow); }
.blueprint-reco-btn:active:not(:disabled) { transform: translateY(1px) scale(.96); }
.blueprint-picker :is(.blueprint-cat-btn,.blueprint-reco-btn):disabled, .blueprint-cat-btn:disabled em { color:var(--text-disabled); cursor:not-allowed; opacity:1; transform:none; }
.blueprint-card {
  border: 1px solid var(--border-soft);
  background: var(--bg-surface);
  color: inherit;
  transition: transform var(--motion-hover) var(--ease-out);
}
.blueprint-card:focus-visible { outline: none; box-shadow: var(--focus-shadow); }
@media (hover:hover) and (pointer:fine) { .blueprint-card:hover:not(:focus-visible) { transform:translateY(-2px); @apply tw:border-accent; box-shadow:var(--shadow-sm); } }
.blueprint-card.active {
  border-color: var(--border-strong);
  border-left-color: var(--pb-active, var(--accent));
  background: var(--accent-soft);
  box-shadow: var(--selection-shadow);
}
.blueprint-card[data-adult="true"] { border-left-color: color-mix(in srgb, var(--danger-text) 55%, transparent); }
.blueprint-card[data-adult="true"].active { border-left-color: var(--danger-text); }
.blueprint-card:active { transform: translateY(0) scale(.99); }
.blueprint-check { @apply tw:text-accent; }
@media (prefers-reduced-motion:reduce) { :root:not([data-motion='full']) :is(.blueprint-card,.blueprint-cat-btn,.blueprint-reco-btn) { transition:none; transform:none; } }
:root:is([data-motion='reduce'],[data-motion='reduced']) :is(.blueprint-card,.blueprint-cat-btn,.blueprint-reco-btn) { transition:none; transform:none; }
@media (forced-colors:active) { .blueprint-results:focus-visible { outline:2px solid Highlight; outline-offset:2px; box-shadow:none; } }
.blueprint-desc {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
</style>
