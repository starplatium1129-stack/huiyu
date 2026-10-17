<template>
  <div class="random-inspiration">
    <StudioPopover v-model:open="menuOpen" label="夏目的调色笔记" content-class="random-popover" prioritize-position>
      <template #trigger>
        <button class="btn btn-ghost btn-sm random-menu-trigger" type="button" :disabled="disabled" aria-label="灵感工具">
          <ArchiveIcon name="gear" class="random-menu-icon" aria-hidden="true" />
          <span class="studio-control-label">灵感工具</span>
        </button>
      </template>
      <header class="random-popover-heading">
        <div><span>INSPIRATION</span><h3>夏目的调色笔记</h3></div>
        <button type="button" class="btn btn-quiet btn-icon" aria-label="关闭调色笔记" @click="menuOpen = false"><ArchiveIcon name="close" /></button>
      </header>
      <div ref="body" class="random-popover-body">
        <button class="btn btn-ghost" type="button" :disabled="disabled" @click="onRoll"><ArchiveIcon name="dice" />夏目的灵感骰子</button>
        <ToggleSwitch v-model="includeArtists" class="random-toggle" label="混入知名画师特调笔触">
          <span class="random-toggle-copy">
            <strong>混入知名画师特调笔触</strong>
            <small>开启后由夏目悄悄塞入画师特调风格；默认关闭，保留少女最纯粹的原生神韵。</small>
          </span>
        </ToggleSwitch>
        <label class="random-seed">灵感种子
          <input v-model="seedText" class="input" type="text" inputmode="numeric" aria-label="灵感种子" placeholder="留空则随机" />
        </label>
        <button class="btn btn-ghost" type="button" :disabled="disabled" @click="previewCandidates">预览 3 组候选</button>
        <ol v-if="candidates.length" v-content-motion="candidates" class="random-candidates" aria-label="灵感候选">
          <li v-for="(candidate, index) in candidates" :key="candidate.recipe.seed" class="random-candidate">
            <div class="random-candidate-heading"><h4>候选 {{ index + 1 }}</h4><small>种子 {{ candidate.recipe.seed }}</small></div>
            <p>{{ candidate.draw.manualTags.join(' · ') || '镜头与情绪组合' }}</p>
            <small v-if="candidate.draw.kept.length">本次保持：{{ candidate.draw.kept.join('、') }}</small>
            <button class="btn btn-ghost" type="button" :disabled="disabled" @click="applyCandidate(index)">应用候选 {{ index + 1 }}</button>
          </li>
        </ol>
        <button v-if="lastRecipe" class="btn btn-ghost" type="button" @click="exportRecipe">保存种子与配置快照</button>
      </div>
      <footer class="random-popover-footer">
        <button class="btn btn-quiet" type="button" :disabled="!canUndo" @click="onUndo">夏目：“退回刚才那一抽”</button>
      </footer>
    </StudioPopover>
  </div>
</template>

<script setup lang="ts">
import StudioPopover from '@/components/ui/StudioPopover.vue'
import ToggleSwitch from '@/components/visual/ToggleSwitch.vue'
import { computed, ref } from 'vue'
import { useResizeObserver } from '@vueuse/core'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import { useRandomInspiration } from '@/composables/useRandomInspiration'

const pb = usePromptBuilderStore()
const { includeArtists, roll, undo, hasUndo, candidates, lastRecipe, prepareCandidates, applyCandidate, exportRecipe } = useRandomInspiration()
const menuOpen = ref(false)
const body = ref<HTMLElement | null>(null)
useResizeObserver(body, () => {
  const active = document.activeElement
  if (menuOpen.value && active instanceof HTMLElement && body.value?.contains(active)) {
    active.scrollIntoView({ block:'nearest', inline:'nearest', behavior:'instant' })
  }
}, { box:'border-box' })
const seedText = ref('')
const disabled = computed(() => !pb.dataReady)
const canUndo = computed(() => Boolean(hasUndo.value))
function previewCandidates() { prepareCandidates(3, seedText.value.trim() ? Number(seedText.value) : undefined) }
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
.random-inspiration { display:inline-flex; align-items:center; min-width:0; }
.random-menu-icon { transition:transform var(--motion-control) var(--ease-out); }
.random-menu-trigger[aria-expanded='true'] .random-menu-icon { transform:rotate(35deg); }
.random-popover-heading { display:flex; align-items:start; justify-content:space-between; gap:var(--s-3); padding:var(--s-3) var(--s-4); border-bottom:1px solid var(--border-soft); }
.random-popover-heading > div { display:grid; gap:var(--s-1); min-width:0; }
.random-popover-heading > div > span { color:var(--text-secondary); font:600 var(--fs-label-xs)/var(--lh-label) var(--font-sans); letter-spacing:.08em; }
.random-popover-heading h3 { margin:0; color:var(--text-primary); font:600 var(--fs-title-sm)/var(--lh-tight) var(--font-sans); overflow-wrap:anywhere; }
.random-popover-heading > button { flex:none; }
.random-popover-body { display:grid; grid-auto-rows:max-content; align-content:start; gap:var(--s-4); min-width:0; min-height:0; padding:var(--s-4); overflow:auto; overscroll-behavior:contain; scroll-padding-block:var(--s-3); }
.random-popover-body > .btn { width:100%; }
/* The switch root is owned by Reka and needs this deep selector. */
.random-popover-body :deep(.random-toggle) { width:100%; min-width:0; min-height:var(--control-height); align-items:start; gap:var(--s-3); }
.random-toggle-copy { display:grid; gap:var(--s-1); min-width:0; }
.random-toggle-copy strong { color:var(--text-primary); font:600 var(--fs-label)/var(--lh-body) var(--font-sans); }
.random-toggle-copy small { color:var(--text-secondary); font:400 var(--fs-label-xs)/var(--lh-body) var(--font-sans); }
.random-seed { display:grid; gap:var(--s-2); min-width:0; color:var(--text-secondary); font:600 var(--fs-label)/var(--lh-label) var(--font-sans); }
.random-candidates { display:grid; gap:var(--s-3); min-width:0; margin:0; padding:0; list-style:none; }
.random-candidate { display:grid; gap:var(--s-3); min-width:0; padding:var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--bg-base); }
.random-candidate-heading { display:flex; flex-wrap:wrap; align-items:baseline; justify-content:space-between; gap:var(--s-1) var(--s-3); }
.random-candidate h4 { margin:0; color:var(--text-primary); font:600 var(--fs-label)/var(--lh-label) var(--font-sans); }
.random-candidate small { color:var(--text-secondary); font:400 var(--fs-label-xs)/var(--lh-body) var(--font-sans); overflow-wrap:anywhere; }
.random-candidate p { margin:0; color:var(--text-primary); font:400 var(--fs-body)/var(--lh-body) var(--font-sans); overflow-wrap:anywhere; }
.random-popover-footer { padding:var(--s-3) var(--s-4); border-top:1px solid var(--border-soft); }
.random-popover-footer .btn { width:100%; }
:root:is([data-motion='reduce'],[data-motion='reduced']) .random-menu-icon { transition:none; }
@media(prefers-reduced-motion:reduce) { :root:not([data-motion='full']) .random-menu-icon { transition:none; } }
</style>

<style>
/* The portalled surface owns the viewport bound; only its body scrolls. */
.studio-popover.random-popover { display:grid; grid-template-rows:auto minmax(0,1fr) auto; width:min(440px,calc(100vw - 32px)); max-height:min(640px,var(--reka-popover-content-available-height,calc(100dvh - 32px))); padding:0; overflow:hidden; background:var(--bg-surface); }
</style>
