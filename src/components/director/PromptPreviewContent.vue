<template>
  <div class="prompt-preview-content">
    <p v-if="!prompt" class="prompt-preview-empty">选择场景或添加词条后，提示词会在这里实时更新。</p>
    <template v-else>
      <section class="prompt-positive" aria-label="正向提示词">
        <h4 class="prompt-content-label">正向提示词 <span>{{ positiveCount }}</span></h4>
        <div v-for="(layers, scopeIndex) in scopes" :key="scopeIndex" class="prompt-layer-list">
          <p v-if="scopes.length > 1" class="prompt-scope-label">分段 {{ scopeIndex + 1 }} · BREAK</p>
          <section v-for="layer in layers" :key="layer.id" class="prompt-layer" :data-layer="layer.id"
            :class="{ 'is-empty': !layer.prose && !layer.groups.some(group => group.tokens.length) }" :aria-label="layer.label">
            <header class="prompt-layer-heading"><span class="prompt-layer-number">{{ layer.number }}</span><h5>{{ layer.label }}</h5></header>
            <div v-for="(group, groupIndex) in layer.groups" v-show="group.tokens.length" :key="groupIndex" class="prompt-layer-group">
              <span v-if="group.label" class="prompt-sub-label">{{ group.label }}</span>
              <div class="prompt-token-flow"><span v-for="(token, index) in group.tokens" :key="index" class="prompt-reading-token">{{ token }}</span></div>
            </div>
            <p v-if="layer.prose" class="prompt-prose">{{ layer.prose }}</p>
            <span v-else-if="!layer.groups.some(group => group.tokens.length)" class="prompt-layer-empty">{{ layer.empty }}</span>
          </section>
        </div>
      </section>
      <details v-if="negativeText" class="prompt-preview-details prompt-negative-section">
        <StudioDisclosureSummary>负向提示词 <span class="prompt-detail-count">{{ negativeCount }}</span></StudioDisclosureSummary>
        <p class="prompt-reading-text prompt-negative">{{ negativeText }}</p>
      </details>
    </template>
  </div>
</template>

<script setup lang="ts">
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import type { PromptPreviewLayer } from '@/utils/promptPreview'

defineProps<{ prompt: string; positiveCount: number; negativeCount: number; scopes: PromptPreviewLayer[][]; negativeText: string }>()
</script>

<style scoped>
.prompt-preview-content { display:grid; gap:var(--s-4); min-width:0; }
.prompt-content-label { display:flex; align-items:baseline; justify-content:space-between; gap:var(--s-2); margin:0 0 var(--s-2); font:600 var(--fs-label)/var(--lh-label) var(--font-sans); color:var(--text-primary); }
.prompt-content-label span { padding:2px var(--s-2); border-radius:var(--r-sm); background:var(--bg-elevated); color:var(--text-secondary); font:500 var(--fs-label-xs)/var(--lh-label) var(--font-mono); }
.prompt-detail-count { margin-inline-start:var(--s-1); color:var(--text-muted); font:400 var(--fs-label-sm)/var(--lh-label) var(--font-mono); }
.prompt-reading-text { margin:0; color:var(--text-secondary); font:400 var(--fs-label)/1.95 var(--font-mono); overflow-wrap:anywhere; word-break:normal; white-space:pre-wrap; }
.prompt-layer-list { display:grid; gap:var(--s-4); padding-top:var(--s-2); }
.prompt-layer-list + .prompt-layer-list { margin-top:var(--s-4); border-top:1px solid var(--border-soft); }
.prompt-scope-label { margin:0; font:500 var(--fs-label)/var(--lh-label) var(--font-sans); color:var(--text-secondary); }
.prompt-layer { --prompt-layer-color:var(--text-secondary); min-width:0; padding-inline-start:var(--s-3); border-inline-start:2px solid color-mix(in srgb,var(--prompt-layer-color) 26%,var(--border-soft)); }
.prompt-layer[data-layer='quality'] { --prompt-layer-color:var(--mood-joy-text); }
.prompt-layer[data-layer='identity'] { --prompt-layer-color:var(--accent); }
.prompt-layer[data-layer='artist'] { --prompt-layer-color:var(--mood-tension-text); }
.prompt-layer[data-layer='visual'] { --prompt-layer-color:var(--info-text); }
.prompt-layer[data-layer='prose'] { --prompt-layer-color:var(--mood-calm-text); }
.prompt-layer-heading { display:flex; align-items:center; gap:var(--s-2); margin-bottom:var(--s-2); color:var(--prompt-layer-color); }
.prompt-layer-heading h5 { margin:0; font:600 var(--fs-label)/var(--lh-label) var(--font-sans); }
.prompt-layer-number { display:grid; place-items:center; flex:none; width:24px; height:24px; border-radius:var(--r-sm); background:color-mix(in srgb,var(--prompt-layer-color) 8%,var(--bg-surface)); font:500 var(--fs-label-xs)/1 var(--font-mono); }
.prompt-layer-group + .prompt-layer-group { margin-top:var(--s-2); }
.prompt-sub-label { display:block; margin-bottom:var(--s-1); color:var(--text-secondary); font-size:var(--fs-label-xs); }
.prompt-token-flow { display:flex; flex-wrap:wrap; align-items:start; gap:var(--s-2); min-width:0; }
.prompt-reading-token { display:inline-block; min-width:0; max-width:100%; padding:3px var(--s-2); border:1px solid color-mix(in srgb,var(--prompt-layer-color) 22%,var(--border-soft)); border-radius:var(--r-sm); color:var(--prompt-layer-color); background:color-mix(in srgb,var(--prompt-layer-color) 5%,var(--bg-surface)); box-shadow:inset 0 1px 0 var(--glass-highlight); font:400 var(--fs-label)/1.55 var(--font-mono); overflow-wrap:anywhere; white-space:normal; }
.prompt-prose { margin:0; padding:var(--s-3); border-radius:var(--r-md); color:var(--text-primary); background:color-mix(in srgb,var(--prompt-layer-color) 5%,var(--bg-surface)); font:400 var(--fs-label)/1.85 var(--font-sans); white-space:pre-wrap; overflow-wrap:anywhere; }
.prompt-layer.is-empty { display:flex; flex-wrap:wrap; align-items:center; column-gap:var(--s-2); row-gap:var(--s-1); }
.prompt-layer.is-empty .prompt-layer-heading { margin-bottom:0; }
.prompt-layer-empty { color:var(--text-muted); font-size:var(--fs-label-xs); }
.prompt-preview-details { min-width:0; border-top:1px solid var(--border-soft); }
.prompt-preview-details > summary { min-height:44px; padding-block:var(--s-2); color:var(--text-secondary); font-size:var(--fs-label); cursor:pointer; list-style:none; }
.prompt-preview-details > summary::-webkit-details-marker { display:none; }
.prompt-preview-details > summary:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
.prompt-negative { padding-block:var(--s-2); }
.prompt-preview-empty { margin:0; padding-block:var(--s-4); color:var(--text-secondary); font-size:var(--fs-label); line-height:var(--lh-body); }
@media (forced-colors:active) {
  .prompt-reading-token { background:Canvas; color:CanvasText; border-color:CanvasText; }
  .prompt-layer { --prompt-layer-color:CanvasText; border-color:CanvasText; }
}
</style>
