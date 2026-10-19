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
