<template>
  <div class="random-inspiration tw:relative tw:inline-flex tw:items-center tw:gap-s-2" :class="{ open: menuOpen }">
    <StudioTooltip anchor :content="disabled ? '数据准备中…' : '夏目：“不知道画什么？那就让我随便给你摇一组词条……顺手而已，别想多。”'">
      <button
        class="random-dice"
        type="button"
        :disabled="disabled"
        @click="onRoll"
      >
        <ArchiveIcon name="dice" class="random-dice-icon" aria-hidden="true" />
        <span>夏目的灵感骰子</span>
      </button>
    </StudioTooltip>
    <StudioPopover v-model:open="menuOpen" label="夏目的调色笔记" content-class="random-popover">
      <template #trigger>
        <button class="random-menu-trigger" type="button" :disabled="disabled" aria-label="夏目的调色笔记">
          <ArchiveIcon name="gear" class="random-menu-icon" aria-hidden="true" />
        </button>
      </template>
        <div class="random-label tw:sticky tw:top-0 tw:flex tw:items-center tw:justify-between tw:text-primary">夏目的调色笔记 <button type="button" class="btn btn-ghost btn-icon" aria-label="关闭调色笔记" @click="menuOpen = false"><ArchiveIcon name="close" /></button></div>
        <ToggleSwitch v-model="includeArtists" class="random-toggle" label="混入知名画师特调笔触">
          <span class="random-toggle-copy tw:flex tw:gap-[2px] tw:text-left">
            <strong class="random-toggle-text tw:text-primary">混入知名画师特调笔触</strong>
            <small class="random-toggle-hint tw:text-muted">开启后由夏目悄悄塞入画师特调风格；默认关闭，保留少女最纯粹的原生神韵。</small>
          </span>
        </ToggleSwitch>
        <label class="random-seed tw:grid tw:gap-s-1 tw:text-secondary tw:text-label-sm">灵感种子
          <input v-model="seedText" type="text" inputmode="numeric" aria-label="灵感种子" placeholder="留空则随机" />
        </label>
        <button class="random-choice tw:w-full tw:min-h-[36px] tw:mt-s-2 tw:rounded-md tw:text-primary tw:cursor-pointer" type="button" @click="previewCandidates">预览 3 组候选</button>
        <div v-for="(candidate, index) in candidates" :key="candidate.recipe.seed" class="random-candidate tw:text-secondary tw:text-label-sm">
          <small>种子 {{ candidate.recipe.seed }}</small>
          <p>{{ candidate.draw.manualTags.join(' · ') || '镜头与情绪组合' }}</p>
          <small v-if="candidate.draw.kept.length">本次保持：{{ candidate.draw.kept.join('、') }}</small>
          <button class="random-choice tw:w-full tw:min-h-[36px] tw:mt-s-2 tw:rounded-md tw:text-primary tw:cursor-pointer" type="button" @click="applyCandidate(index)">应用候选 {{ index + 1 }}</button>
        </div>
        <button v-if="lastRecipe" class="random-choice tw:w-full tw:min-h-[36px] tw:mt-s-2 tw:rounded-md tw:text-primary tw:cursor-pointer" type="button" @click="exportRecipe">保存种子与配置快照</button>
        <button class="random-undo tw:w-full tw:min-h-[36px] tw:mt-s-2 tw:rounded-md tw:text-secondary tw:cursor-pointer" type="button" :disabled="!canUndo" @click="onUndo">
          夏目：“退回刚才那一抽”
        </button>
    </StudioPopover>
  </div>
</template>

<script setup lang="ts">
import StudioPopover from '@/components/ui/StudioPopover.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
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
@reference "../assets/css/tailwind.css";
.random-dice {
  @apply tw:min-h-[36px] tw:inline-flex tw:items-center tw:justify-center tw:gap-s-2;
  padding: 0 var(--s-3);
  border: 1px solid var(--border-soft);
  @apply tw:rounded-md;
  background: transparent;
  @apply tw:text-secondary tw:cursor-pointer;
  font: 650 var(--fs-label-sm) var(--font-sans);
  transition: background var(--motion-hover), border-color var(--motion-hover), color var(--motion-hover), transform var(--motion-hover);
}
.random-dice:hover {
  border-color: color-mix(in srgb, var(--accent) 50%, var(--border-soft));
  background: var(--bg-elevated);
  @apply tw:text-accent;
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
  @apply tw:text-disabled;
  border-color: color-mix(in srgb, var(--border-soft) 40%, transparent);
  background: color-mix(in srgb, var(--bg-deep) 60%, transparent);
  @apply tw:cursor-not-allowed;
  transform: none;
}
.random-dice-icon {
  @apply tw:inline-grid;
  place-items: center;
  @apply tw:text-body-lg tw:leading-flush;
}
.random-menu-trigger {
  @apply tw:w-[36px] tw:h-[36px] tw:grid;
  place-items: center;
  border: 1px solid var(--border-soft);
  border-radius: 50%;
  background: transparent;
  @apply tw:text-secondary tw:cursor-pointer;
  transition: background var(--motion-hover), border-color var(--motion-hover), color var(--motion-hover), transform var(--motion-hover);
}
.random-menu-trigger:hover,
.random-inspiration.open .random-menu-trigger {
  border-color: color-mix(in srgb, var(--accent) 50%, var(--border-soft));
  background: var(--bg-elevated);
  @apply tw:text-accent;
}
.random-menu-icon {
  @apply tw:grid;
  place-items: center;
  @apply tw:text-body tw:leading-flush;
}
.random-seed { margin-block: var(--s-2); }
.random-seed input { @apply tw:min-w-0 tw:p-s-2 tw:text-primary; background: var(--bg-deep); border: 1px solid var(--border-soft); @apply tw:rounded-md; }
.random-choice { border: 1px solid var(--border-soft); background: var(--bg-deep); }
.random-candidate { padding-block: var(--s-2); border-bottom: 1px solid var(--border-soft); }
.random-candidate p { overflow-wrap: anywhere; margin: var(--s-1) 0; }
.random-label {
  z-index: 1;
  background: var(--bg-surface);
  margin: 2px 4px 8px;
  font: 600 var(--fs-body)/var(--lh-body) var(--font-sans);
}
.random-toggle {
  @apply tw:flex tw:items-start tw:gap-s-3 tw:w-full tw:p-s-2 tw:rounded-md tw:cursor-pointer;
}
.random-toggle:hover {
  background: var(--bg-elevated);
}
.random-toggle-copy {
  @apply tw:flex-col;
  flex: 1;
}
.random-toggle-text {
  font: 500 var(--fs-label-sm) var(--font-sans);
}
.random-toggle-hint {
  font: var(--fs-label-xs) var(--font-sans);
  line-height: 1.5;
}
.random-undo {
  border: 1px solid var(--border-soft);
  background: transparent;
  font: 650 var(--fs-label-sm) var(--font-sans);
  transition: background var(--motion-hover), border-color var(--motion-hover), color var(--motion-hover);
}
.random-undo:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--accent) 50%, var(--border-soft));
  background: var(--bg-elevated);
  @apply tw:text-accent;
}
.random-undo:disabled {
  @apply tw:text-disabled;
  border-color: color-mix(in srgb, var(--border-soft) 60%, transparent);
  background: var(--bg-deep);
  @apply tw:cursor-not-allowed;
  transform: none;
}
</style>
