<script setup lang="ts">
import { computed } from 'vue'
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
  <div class="blueprint-picker">
    <div class="blueprint-cats" role="group" aria-label="蓝图分类">
      <button v-for="chip in categoryChips" :key="chip.id"
        type="button" class="blueprint-cat-btn"
        :class="{ active: props.category === chip.id, adult: chip.adult }"
        :aria-pressed="props.category === chip.id"
        @click="emit('update:category', chip.id === 'all' ? 'all' : chip.id)">
        {{ chip.label }}<em v-if="chip.count">{{ chip.count }}</em>
      </button>
    </div>
    <div class="blueprint-reco-head">
      <span v-if="!props.showAll" class="blueprint-reco-note" role="status">推荐 {{ props.recommended.length }} 个场景</span>
      <span v-else class="blueprint-reco-note" role="status">{{ props.filtered.length }} 个可选场景</span>
      <button type="button" class="blueprint-reco-btn" @click="emit('toggle')">
        {{ props.showAll ? '收起 · 只看推荐' : '查看全部' }}
      </button>
      <button v-if="!props.showAll" type="button" class="blueprint-reco-btn" @click="emit('rotate')">换一批</button>
    </div>
    <div v-if="!props.dataReady" class="scene-loading">正在加载热门角色场景…</div>
    <div v-else-if="!props.filtered.length" class="scene-empty">没有符合条件的场景建议</div>
    <div v-else class="blueprint-list">
      <button v-for="blueprint in (props.showAll ? props.filtered : props.recommended)"
        :key="blueprint.id" type="button" class="blueprint-card"
        :class="{ active: props.selectedBlueprintId === blueprint.id }"
        :data-adult="blueprint.adult ? 'true' : 'false'"
        :aria-pressed="props.selectedBlueprintId === blueprint.id"
        @click="emit('select', blueprint)">
        <span class="blueprint-title">{{ blueprint.title }}<span v-if="blueprint.adult" class="scene-rating-tag">R18</span></span>
        <span class="blueprint-desc">{{ blueprint.description }}</span>
        <span class="blueprint-meta">
          <span>{{ blueprint.category }}</span>
          <span>{{ blueprint.location }}</span>
          <span>{{ blueprint.recommendedSize.replace('x', '×') }}</span>
        </span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.blueprint-picker {
  display: contents;
}
.blueprint-cats {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin: var(--s-1) 0 var(--s-2);
}
.blueprint-cat-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px var(--s-3);
  border-radius: var(--r-pill);
  border: 1px solid var(--border-soft);
  background: var(--glass-fill);
  color: var(--text-secondary);
  font: 650 var(--fs-label-sm) var(--font-sans);
  cursor: pointer;
  transition: border-color var(--motion-hover), color var(--motion-hover), background var(--motion-hover), transform var(--motion-hover) var(--ease-out);
}
.blueprint-cat-btn:active { transform: translateY(1px) scale(.96); }
.blueprint-cat-btn em { font-style: normal; font: 700 var(--fs-mono-xs) var(--font-mono); color: var(--text-muted); }
.blueprint-cat-btn:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--border-soft)); color: var(--text-primary); }
.blueprint-cat-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.blueprint-cat-btn.active {
  border-color: var(--pb-active, var(--accent));
  background: color-mix(in srgb, var(--mood-love) 18%, var(--bg-elevated));
  color: var(--accent);
}
.blueprint-cat-btn.adult { border-color: color-mix(in srgb, var(--danger-text) 40%, var(--border-soft)); }
.blueprint-cat-btn.adult em { color: var(--danger-text); opacity: .9; }
.blueprint-cat-btn.adult:hover,
.blueprint-cat-btn.adult.active {
  border-color: var(--danger-text);
  background: var(--bg-elevated);
  color: var(--danger-text);
}
.blueprint-reco-head {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  flex-wrap: wrap;
  margin-bottom: var(--s-2);
}
.blueprint-reco-note {
  font-size: var(--fs-mono-sm);
  color: var(--text-muted);
}
.blueprint-reco-btn {
  min-height: 28px;
  padding: 3px var(--s-3);
  border-radius: var(--r-md);
  border: 1px solid var(--border-soft);
  background: var(--glass-fill);
  color: var(--text-secondary);
  font-size: var(--fs-mono-sm);
  cursor: pointer;
  transition: border-color var(--motion-hover), color var(--motion-hover), transform var(--motion-hover) var(--ease-out);
}
.blueprint-reco-btn:hover { border-color: var(--accent); color: var(--accent); }
.blueprint-reco-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.blueprint-reco-btn:active { transform: translateY(1px) scale(.96); }
.blueprint-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.blueprint-card {
  display: flex;
  flex-direction: column;
  gap: 3px;
  text-align: left;
  padding: var(--s-2) var(--s-3);
  border-radius: var(--r-md);
  border: 1px solid var(--border-soft);
  border-left: 3px solid color-mix(in srgb, var(--border-strong) 60%, transparent);
  background: var(--glass-fill);
  color: inherit;
  cursor: pointer;
  transition: border-color var(--motion-hover), background var(--motion-hover), transform var(--motion-hover) var(--ease-out), box-shadow var(--motion-hover);
}
.blueprint-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.blueprint-card:hover {
  transform: translateY(-1px);
  border-color: color-mix(in srgb, var(--accent) 40%, var(--border-soft));
}
.blueprint-card.active {
  border-color: var(--pb-active, var(--accent));
  border-left-color: var(--pb-active, var(--accent));
  background: color-mix(in srgb, var(--mood-love) 12%, transparent);
  box-shadow: 0 0 0 2px var(--accent-glow);
}
.blueprint-card[data-adult="true"] { border-left-color: color-mix(in srgb, var(--danger-text) 55%, transparent); }
.blueprint-card[data-adult="true"].active { border-left-color: var(--danger-text); }
.blueprint-card:active { transform: translateY(0) scale(.99); }
.blueprint-title {
  font-size: var(--fs-label);
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
}
.blueprint-desc {
  font-size: var(--fs-label-xs);
  color: var(--text-secondary);
  line-height: var(--lh-label);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}
.blueprint-meta {
  display: flex;
  gap: var(--s-2);
  flex-wrap: wrap;
  font-size: var(--fs-mono-xs);
  color: var(--text-muted);
}
</style>
