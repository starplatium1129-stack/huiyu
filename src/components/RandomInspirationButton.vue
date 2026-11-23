<template>
  <div class="random-inspiration" role="group" aria-label="灵感工具">
    <button class="btn btn-ghost btn-sm random-roll" type="button" :disabled="disabled"
      aria-label="夏目的灵感笔记，随机一组提示词" @click="roll()">
      <ArchiveIcon name="dice" />夏目的灵感笔记
    </button>
    <StudioPopover v-model:open="menuOpen" label="灵感设置" content-class="random-popover" prioritize-position>
      <template #trigger>
        <button class="btn btn-quiet btn-icon btn-sm random-menu-trigger" type="button" :disabled="disabled" aria-label="灵感设置">
          <StudioToggleIcon :active="menuOpen" />
        </button>
      </template>
      <header class="random-popover-heading">
        <h3>灵感设置</h3>
        <button type="button" class="btn btn-quiet btn-icon" aria-label="关闭灵感设置" @click="menuOpen = false"><ArchiveIcon name="close" /></button>
      </header>
      <div ref="body" class="random-popover-body">
        <ToggleSwitch v-model="includeArtists" :disabled="disabled">随机加入画师风格</ToggleSwitch>
        <label class="random-seed">灵感种子
          <input v-model="seedText" class="input" type="text" inputmode="numeric" :disabled="disabled" placeholder="留空则随机" />
        </label>
        <button class="btn btn-ghost" type="button" :disabled="disabled" @click="onRoll"><ArchiveIcon name="dice" />{{ seedText.trim() ? '按种子抽取' : '再抽一次' }}</button>
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
        <button class="btn btn-quiet" type="button" :disabled="disabled || !hasUndo" @click="onUndo">撤销上一次抽取</button>
      </footer>
    </StudioPopover>
  </div>
</template>

<script setup lang="ts">
import StudioPopover from '@/components/ui/StudioPopover.vue'
import StudioToggleIcon from '@/components/ui/StudioToggleIcon.vue'
import ToggleSwitch from '@/components/visual/ToggleSwitch.vue'
import { computed, ref } from 'vue'
import { useResizeObserver } from '@vueuse/core'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import { useRandomInspiration } from '@/composables/useRandomInspiration'

const props = defineProps<{ blocked?: boolean }>()

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
const disabled = computed(() => props.blocked || !pb.dataReady)
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
.random-inspiration { display:inline-flex; align-items:center; gap:var(--s-1); min-width:0; }
.random-popover-heading { display:flex; align-items:center; justify-content:space-between; gap:var(--s-3); padding:var(--s-3) var(--s-4); border-bottom:1px solid var(--border-soft); }
.random-popover-heading h3 { margin:0; color:var(--text-primary); font:600 var(--fs-title-sm)/var(--lh-tight) var(--font-sans); overflow-wrap:anywhere; }
.random-popover-heading > button { flex:none; }
.random-popover-body { display:grid; grid-auto-rows:max-content; align-content:start; gap:var(--s-4); min-width:0; min-height:0; padding:var(--s-4); overflow:auto; overscroll-behavior:contain; scroll-padding-block:var(--s-3); }
.random-popover-body > .btn { width:100%; }
.random-seed { display:grid; gap:var(--s-2); min-width:0; color:var(--text-secondary); font:600 var(--fs-label)/var(--lh-label) var(--font-sans); }
.random-candidates { display:grid; gap:var(--s-3); min-width:0; margin:0; padding:0; list-style:none; }
.random-candidate { display:grid; gap:var(--s-3); min-width:0; padding:var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--bg-base); }
.random-candidate-heading { display:flex; flex-wrap:wrap; align-items:baseline; justify-content:space-between; gap:var(--s-1) var(--s-3); }
.random-candidate h4 { margin:0; color:var(--text-primary); font:600 var(--fs-label)/var(--lh-label) var(--font-sans); }
.random-candidate small { color:var(--text-secondary); font:400 var(--fs-label-xs)/var(--lh-body) var(--font-sans); overflow-wrap:anywhere; }
.random-candidate p { margin:0; color:var(--text-primary); font:400 var(--fs-body)/var(--lh-body) var(--font-sans); overflow-wrap:anywhere; }
.random-popover-footer { padding:var(--s-3) var(--s-4); border-top:1px solid var(--border-soft); }
.random-popover-footer .btn { width:100%; }
@media (pointer:coarse) {
  .random-roll,.random-menu-trigger { min-block-size:44px; min-inline-size:44px; }
}
</style>

<style>
/* The portalled surface owns the viewport bound; only its body scrolls. */
.studio-popover.random-popover { display:grid; grid-template-rows:auto minmax(0,1fr) auto; width:min(440px,calc(100vw - 32px)); max-height:min(640px,var(--reka-popover-content-available-height,calc(100dvh - 32px))); padding:0; overflow:hidden; background:var(--bg-surface); }
</style>
