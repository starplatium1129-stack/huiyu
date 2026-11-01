<script setup lang="ts">
import { ref } from 'vue'
import type { CatalogChange, CatalogRecord } from '@/api/catalogApi'
import AsyncPanel from '@/components/ui/AsyncPanel.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'

defineProps<{ record: CatalogRecord; pending: CatalogChange[]; dirty: boolean }>()
const opened = ref(false), revealed = ref(false)
const loadPreview = () => import('./CatalogPromptPreviewBody.vue')
function toggle(event: Event) {
  opened.value = (event.target as HTMLDetailsElement).open
  if (opened.value) revealed.value = true
}
</script>

<template>
  <details class="catalog-writing-section catalog-prompt-preview" @toggle="toggle">
    <StudioDisclosureSummary>绘制提示词预览</StudioDisclosureSummary>
    <AsyncPanel v-if="revealed" :loader="loadPreview" label="绘制提示词预览" v-slot="{ component }">
      <component :is="component" :record="record" :pending="pending" :dirty="dirty" :opened="opened" />
    </AsyncPanel>
  </details>
</template>
