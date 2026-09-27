<script setup lang="ts">
import { computed } from 'vue'
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
  selectedBlueprintId: string
}>()

const emit = defineEmits<{
  'update:category': [value: string]
  'update:showAll': [value: boolean]
  select: [blueprint: SceneBlueprint]
  rotate: []
  toggle: []
}>()

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
  <div class="blueprint-picker tw:contents">
    <div class="blueprint-cats tw:flex tw:gap-[6px] tw:flex-wrap" role="group" aria-label="蓝图分类">
      <button v-for="chip in categoryChips" :key="chip.id"
        type="button" class="blueprint-cat-btn tw:inline-flex tw:items-center tw:gap-[5px] tw:rounded-pill tw:text-secondary tw:cursor-pointer"
        :class="{ active: props.category === chip.id, adult: chip.adult }"
        :aria-pressed="props.category === chip.id"
        @click="emit('update:category', chip.id === 'all' ? 'all' : chip.id)">
        {{ chip.label }}<em v-if="chip.count">{{ chip.count }}</em>
      </button>
    </div>
    <div class="blueprint-reco-head tw:flex tw:items-center tw:gap-s-2 tw:flex-wrap tw:mb-s-2">
      <span v-if="!props.showAll" class="blueprint-reco-note tw:text-mono-sm tw:text-muted" role="status">推荐 {{ props.recommended.length }} 个场景</span>
      <span v-else class="blueprint-reco-note tw:text-mono-sm tw:text-muted" role="status">{{ props.filtered.length }} 个可选场景</span>
      <button type="button" class="blueprint-reco-btn tw:min-h-[28px] tw:rounded-md tw:text-secondary tw:text-mono-sm tw:cursor-pointer" @click="emit('toggle')">
        {{ props.showAll ? '收起 · 只看推荐' : '查看全部' }}
      </button>
      <button v-if="!props.showAll" type="button" class="blueprint-reco-btn tw:min-h-[28px] tw:rounded-md tw:text-secondary tw:text-mono-sm tw:cursor-pointer" @click="emit('rotate')">换一批</button>
    </div>
    <div v-if="!props.dataReady" class="scene-loading">正在加载热门角色场景…</div>
    <div v-else-if="!props.filtered.length" class="scene-empty">没有符合条件的场景建议</div>
    <div v-else class="blueprint-list tw:flex tw:flex-col tw:gap-s-2 tw:p-s-1">
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
</template>

<style scoped>
@reference "../../assets/css/tailwind.css";
.blueprint-cats {
  margin: var(--s-1) 0 var(--s-2);
}
.blueprint-cat-btn {
  padding: 3px var(--s-3);
  border: 1px solid var(--border-soft);
  background: var(--glass-fill);
  font: 650 var(--fs-label-sm) var(--font-sans);
  transition: border-color var(--motion-hover), color var(--motion-hover), background var(--motion-hover), transform var(--motion-hover) var(--ease-out);
}
.blueprint-cat-btn:active { transform: translateY(1px) scale(.96); }
.blueprint-cat-btn em { @apply tw:not-italic; font: 700 var(--fs-mono-xs) var(--font-mono); @apply tw:text-muted; }
.blueprint-cat-btn:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--border-soft)); @apply tw:text-primary; }
.blueprint-cat-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.blueprint-cat-btn.active {
  border-color: var(--pb-active, var(--accent));
  background: color-mix(in srgb, var(--mood-love) 18%, var(--bg-elevated));
  @apply tw:text-accent;
}
.blueprint-cat-btn.adult { border-color: color-mix(in srgb, var(--danger-text) 40%, var(--border-soft)); }
.blueprint-cat-btn.adult em { @apply tw:text-danger-text; opacity: .9; }
.blueprint-cat-btn.adult:hover,
.blueprint-cat-btn.adult.active {
  @apply tw:border-danger-text;
  background: var(--bg-elevated);
  @apply tw:text-danger-text;
}
.blueprint-reco-btn {
  padding: 3px var(--s-3);
  border: 1px solid var(--border-soft);
  background: var(--glass-fill);
  transition: border-color var(--motion-hover), color var(--motion-hover), transform var(--motion-hover) var(--ease-out);
}
.blueprint-reco-btn:hover { @apply tw:border-accent tw:text-accent; }
.blueprint-reco-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.blueprint-reco-btn:active { transform: translateY(1px) scale(.96); }
.blueprint-card {
  border: 1px solid var(--border-soft);
  background: var(--bg-surface);
  color: inherit;
  transition: transform var(--motion-hover) var(--ease-out);
}
.blueprint-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
@media (hover:hover) and (pointer:fine) { .blueprint-card:hover { transform:translateY(-2px); @apply tw:border-accent; box-shadow:var(--shadow-sm); } }
.blueprint-card.active {
  border-color: var(--pb-active, var(--accent));
  border-left-color: var(--pb-active, var(--accent));
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 1px var(--accent);
}
.blueprint-card[data-adult="true"] { border-left-color: color-mix(in srgb, var(--danger-text) 55%, transparent); }
.blueprint-card[data-adult="true"].active { border-left-color: var(--danger-text); }
.blueprint-card:active { transform: translateY(0) scale(.99); }
.blueprint-check { @apply tw:text-accent; }
@media (prefers-reduced-motion:reduce) { .blueprint-card { transition:none; transform:none; } }
.blueprint-desc {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
</style>
