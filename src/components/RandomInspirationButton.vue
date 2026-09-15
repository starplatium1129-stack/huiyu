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
    <button
      class="random-menu-trigger"
      type="button"
      :disabled="disabled"
      aria-label="夏目的调色笔记"
      :aria-expanded="menuOpen"
      @click="menuOpen = !menuOpen"
    >
      <ArchiveIcon name="gear" class="random-menu-icon" aria-hidden="true" />
    </button>
    <FluidTransition>
      <div v-if="menuOpen" class="random-popover" role="dialog" aria-label="夏目的调色笔记">
        <div class="random-label">夏目的调色笔记</div>
        <label class="random-toggle">
          <input v-model="includeArtists" type="checkbox" />
          <span class="random-toggle-text">混入知名画师特调笔触</span>
          <small class="random-toggle-hint">开启后由夏目悄悄塞入画师特调风格；默认关闭，保留少女最纯粹的原生神韵。</small>
        </label>
        <button class="random-undo" type="button" :disabled="!canUndo" @click="onUndo">
          夏目：“退回刚才那一抽”
        </button>
      </div>
    </FluidTransition>
  </div>
</template>

<script setup lang="ts">
import FluidTransition from "@/components/visual/FluidTransition.vue"
import { computed, ref } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import { useRandomInspiration } from '@/composables/useRandomInspiration'

const pb = usePromptBuilderStore()
const { includeArtists, roll, undo, hasUndo } = useRandomInspiration()

const menuOpen = ref(false)
const disabled = computed(() => !pb.dataReady)
const canUndo = computed(() => Boolean(hasUndo.value))

function onRoll() {
  menuOpen.value = false
  roll()
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
.random-popover {
  position: absolute;
  z-index: var(--z-popover);
  top: calc(100% + 10px);
  right: 0;
  width: min(280px, calc(100vw - 32px));
  padding: var(--s-3);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-2xl);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-lg);
  transform-origin: top right;
}
.popover-pop-enter-active {
  transition: opacity var(--motion-hover) var(--ease-out), transform var(--motion-hover) var(--ease-out);
}
.popover-pop-leave-active {
  transition: opacity 120ms ease-out, transform 120ms ease-out;
}
.popover-pop-enter-from,
.popover-pop-leave-to {
  opacity: 0;
  transform: translateY(-6px) scale(0.96);
}
.random-label {
  margin: 2px 4px 8px;
  color: var(--text-muted);
  font: 700 var(--fs-mono-xs) var(--font-mono);
  letter-spacing: .1em;
  text-transform: uppercase;
}
.random-toggle {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px var(--s-2);
  align-items: center;
  padding: var(--s-2);
  border-radius: var(--r-md);
  cursor: pointer;
}
.random-toggle:hover {
  background: var(--bg-elevated);
}
.random-toggle input {
  grid-row: 1 / 3;
  accent-color: var(--accent);
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
