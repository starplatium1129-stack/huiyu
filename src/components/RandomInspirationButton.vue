<template>
  <div class="random-inspiration" :class="{ open: menuOpen }">
    <button
      class="random-dice"
      type="button"
      :disabled="disabled"
      :title="disabled ? '数据准备中…' : '夏目：“不知道画什么？那就让我随便给你摇一组词条……顺手而已，别想多。”'"
      @click="onRoll"
    >
      <ArchiveIcon name="dice" class="random-dice-icon" aria-hidden="true" />
      <span>夏目的灵感骰子</span>
    </button>
    <StudioPopover v-model:open="menuOpen" label="夏目的调色笔记" content-class="random-popover">
      <template #trigger>
        <button class="random-menu-trigger" type="button" :disabled="disabled" aria-label="夏目的调色笔记">
          <ArchiveIcon name="gear" class="random-menu-icon" aria-hidden="true" />
        </button>
      </template>
        <div class="random-label">夏目的调色笔记 <button type="button" class="btn btn-ghost btn-icon" aria-label="关闭调色笔记" @click="menuOpen = false"><ArchiveIcon name="close" /></button></div>
        <ToggleSwitch v-model="includeArtists" class="random-toggle" label="混入知名画师特调笔触">
          <span class="random-toggle-copy">
            <strong class="random-toggle-text">混入知名画师特调笔触</strong>
            <small class="random-toggle-hint">开启后由夏目悄悄塞入画师特调风格；默认关闭，保留少女最纯粹的原生神韵。</small>
          </span>
        </ToggleSwitch>
        <label class="random-seed">灵感种子
          <input v-model="seedText" type="text" inputmode="numeric" aria-label="灵感种子" placeholder="留空则随机" />
        </label>
        <button class="random-choice" type="button" @click="previewCandidates">预览 3 组候选</button>
        <div v-for="(candidate, index) in candidates" :key="candidate.recipe.seed" class="random-candidate">
          <small>种子 {{ candidate.recipe.seed }}</small>
          <p>{{ candidate.draw.manualTags.join(' · ') || '镜头与情绪组合' }}</p>
          <button class="random-choice" type="button" @click="applyCandidate(index)">应用候选 {{ index + 1 }}</button>
        </div>
        <button v-if="lastRecipe" class="random-choice" type="button" @click="exportRecipe">保存种子与配置快照</button>
        <button class="random-undo" type="button" :disabled="!canUndo" @click="onUndo">
          夏目：“退回刚才那一抽”
        </button>
    </StudioPopover>
  </div>
</template>

<script setup lang="ts">
import StudioPopover from '@/components/ui/StudioPopover.vue'
import ToggleSwitch from '@/components/visual/ToggleSwitch.vue'
import { computed, ref } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import { useRandomInspiration } from '@/composables/useRandomInspiration'

const pb = usePromptBuilderStore()
const { includeArtists, roll, undo, hasUndo, candidates, lastRecipe, prepareCandidates, applyCandidate, exportRecipe } = useRandomInspiration()

const menuOpen = ref(false)
const seedText = ref('')
function previewCandidates() { prepareCandidates(3, seedText.value.trim() ? Number(seedText.value) : undefined) }
const disabled = computed(() => !pb.dataReady)
const canUndo = computed(() => Boolean(hasUndo.value))

function onRoll() {
  menuOpen.value = false
  roll(seedText.value.trim() ? Number(seedText.value) : undefined)
}

function onUndo() {
  menuOpen.value = false
  undo()
}
</script>

<style scoped>
.random-inspiration {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--s-2);
}
.random-dice {
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--s-2);
  padding: 0 var(--s-3);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-md);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font: 650 var(--fs-label-sm) var(--font-sans);
  transition: background var(--motion-hover), border-color var(--motion-hover), color var(--motion-hover), transform var(--motion-hover);
}
.random-dice:hover {
  border-color: color-mix(in srgb, var(--accent) 50%, var(--border-soft));
  background: var(--bg-elevated);
  color: var(--accent);
}
.random-dice:focus-visible,
.random-menu-trigger:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.random-dice:active,
.random-menu-trigger:active {
  transform: scale(.95);
}
.random-dice:disabled,
.random-menu-trigger:disabled {
  color: var(--text-disabled);
  border-color: color-mix(in srgb, var(--border-soft) 40%, transparent);
  background: color-mix(in srgb, var(--bg-deep) 60%, transparent);
  cursor: not-allowed;
  transform: none;
}
.random-dice-icon {
  display: inline-grid;
  place-items: center;
  font-size: var(--fs-body-lg);
  line-height: var(--lh-flush);
}
.random-menu-trigger {
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  border: 1px solid var(--border-soft);
  border-radius: 50%;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background var(--motion-hover), border-color var(--motion-hover), color var(--motion-hover), transform var(--motion-hover);
}
.random-menu-trigger:hover,
.random-inspiration.open .random-menu-trigger {
  border-color: color-mix(in srgb, var(--accent) 50%, var(--border-soft));
  background: var(--bg-elevated);
  color: var(--accent);
}
.random-menu-icon {
  display: grid;
  place-items: center;
  font-size: var(--fs-body);
  line-height: var(--lh-flush);
}
.random-seed { display: grid; gap: var(--s-1); color: var(--text-secondary); font-size: var(--fs-label-sm); margin-block: var(--s-2); }
.random-seed input { min-width: 0; padding: var(--s-2); color: var(--text-primary); background: var(--bg-deep); border: 1px solid var(--border-soft); border-radius: var(--r-md); }
.random-choice { width: 100%; min-height: 36px; margin-top: var(--s-2); border: 1px solid var(--border-soft); border-radius: var(--r-md); color: var(--text-primary); background: var(--bg-deep); cursor: pointer; }
.random-candidate { padding-block: var(--s-2); border-bottom: 1px solid var(--border-soft); color: var(--text-secondary); font-size: var(--fs-label-sm); }
.random-candidate p { overflow-wrap: anywhere; margin: var(--s-1) 0; }
.random-label {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--bg-surface);
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 2px 4px 8px;
  color: var(--text-primary);
  font: 600 var(--fs-body)/var(--lh-body) var(--font-sans);
}
.random-toggle {
  display: flex;
  align-items: flex-start;
  gap: var(--s-3);
  width: 100%;
  padding: var(--s-2);
  border-radius: var(--r-md);
  cursor: pointer;
}
.random-toggle:hover {
  background: var(--bg-elevated);
}
.random-toggle-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  text-align: left;
}
.random-toggle-text {
  color: var(--text-primary);
  font: 500 var(--fs-label-sm) var(--font-sans);
}
.random-toggle-hint {
  color: var(--text-muted);
  font: var(--fs-label-xs) var(--font-sans);
  line-height: 1.5;
}
.random-undo {
  width: 100%;
  min-height: 36px;
  margin-top: var(--s-2);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-md);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font: 650 var(--fs-label-sm) var(--font-sans);
  transition: background var(--motion-hover), border-color var(--motion-hover), color var(--motion-hover);
}
.random-undo:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--accent) 50%, var(--border-soft));
  background: var(--bg-elevated);
  color: var(--accent);
}
.random-undo:disabled {
  color: var(--text-disabled);
  border-color: color-mix(in srgb, var(--border-soft) 60%, transparent);
  background: var(--bg-deep);
  cursor: not-allowed;
  transform: none;
}
</style>
