<script setup lang="ts">
import { computed, ref, toRef } from 'vue'
import type { CatalogChange, CatalogRecord } from '@/api/catalogApi'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import StudioCopyButton from '@/components/ui/StudioCopyButton.vue'
import PromptPreviewContent from '@/components/director/PromptPreviewContent.vue'
import { useCatalogPromptPreview } from '@/composables/scene/useCatalogPromptPreview'
import { promptPreviewScopes } from '@/utils/promptPreview'
import { resolveDrawCapabilities } from '@/utils/drawCapabilities'
import { tokenize } from '@/utils/promptPolicy'
import { copyText } from '@/utils/clipboard'

const props = defineProps<{ record: CatalogRecord; pending: CatalogChange[]; dirty: boolean }>()
const opened = ref(false)
const { modelId, modelGroups, engine, outfitId, outfitOptions, isStudio, loading, readError, preview, provenance, reload }
  = useCatalogPromptPreview(toRef(props, 'record'), toRef(props, 'pending'), opened, toRef(props, 'dirty'))
const result = computed(() => preview.value.result)
const capabilities = computed(() => resolveDrawCapabilities(engine.value, result.value?.profile))
const scopes = computed(() => result.value ? promptPreviewScopes(result.value.prompt, {
  format: capabilities.value.promptFormat,
  characterTokens: result.value.plan.characterTokens,
  copyrightTokens: result.value.plan.copyrightTokens,
  qualityTokens: result.value.plan.quality,
  artists: result.value.plan.artists,
}) : [])
const positiveCount = computed(() => tokenize(result.value?.prompt || '').length)
const negativeCount = computed(() => tokenize(result.value?.negative || '').length)
</script>

<template>
  <details class="catalog-writing-section catalog-prompt-preview" @toggle="opened = ($event.target as HTMLDetailsElement).open">
    <StudioDisclosureSummary>绘制提示词预览</StudioDisclosureSummary>
    <div v-if="opened" data-disclosure-content class="catalog-prompt-body" :aria-busy="loading">
      <p class="catalog-note">随当前编辑与关联的暂存修改更新。这里只编译文字，不生成图片。</p>
      <div class="catalog-prompt-controls">
        <label class="form-group">
          <span class="field-label">预览模型</span>
          <StudioSelect v-model="modelId" label="预览模型" :groups="modelGroups" :disabled="loading || !modelGroups.some(group => group.options.length)" />
        </label>
        <label v-if="record.kind === 'character' && !isStudio && outfitOptions.length > 1" class="form-group">
          <span class="field-label">搭配衣装</span>
          <StudioSelect v-model="outfitId" label="搭配衣装" :options="outfitOptions" :disabled="loading" />
        </label>
      </div>
      <p v-if="provenance" class="catalog-note">{{ provenance }}</p>
      <p v-if="record.kind === 'character' && isStudio" class="catalog-note">档案中的故事与外观说明不直接进入绘制身份；下方使用当前工作室的角色设定。</p>
      <p v-if="loading" class="catalog-note" role="status">正在读取预览所需的资料…</p>
      <p v-else-if="readError" class="catalog-error" role="alert">{{ readError }}</p>
      <p v-else-if="preview.error" class="catalog-error" role="alert">{{ preview.error }}</p>
      <div class="catalog-actions">
        <button class="btn btn-quiet btn-sm" type="button" :disabled="loading" @click="reload">{{ readError ? '重新读取' : '重读关联资料' }}</button>
      </div>
      <template v-if="result">
        <dl class="catalog-prompt-sources" aria-label="本次使用的内容">
          <div v-for="source in preview.sources" :key="source.label"><dt>{{ source.label }}</dt><dd>{{ source.value }}</dd></div>
        </dl>
        <div class="catalog-actions">
          <StudioCopyButton class="btn btn-ghost btn-sm" label="复制正向提示词" :action="() => copyText(result?.prompt || '')" :content-key="result.prompt" />
          <StudioCopyButton v-if="result.negative" class="btn btn-ghost btn-sm" label="复制负向提示词" :action="() => copyText(result?.negative || '')" :content-key="result.negative" />
        </div>
        <PromptPreviewContent :prompt="result.prompt" :scopes="scopes" :negative-text="result.negative" :positive-count="positiveCount" :negative-count="negativeCount" />
        <p v-if="!capabilities.negative" class="catalog-note">此模型不使用负向提示词。</p>
        <details class="catalog-prompt-raw">
          <StudioDisclosureSummary>完整正向文本</StudioDisclosureSummary>
          <textarea class="input" rows="8" readonly :value="result.prompt" aria-label="编译后的完整正向提示词" spellcheck="false" autocorrect="off" autocapitalize="off"></textarea>
        </details>
      </template>
    </div>
  </details>
</template>

<style scoped>
.catalog-prompt-body { display:grid; gap:var(--s-4); min-width:0; padding-bottom:var(--s-5); }
.catalog-prompt-body > p,.catalog-prompt-body .catalog-actions { margin:0; }
.catalog-prompt-controls { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr)); gap:var(--s-4); }
.catalog-prompt-sources,.catalog-prompt-raw { min-width:0; color:var(--text-secondary); font-size:var(--fs-body-sm); }
.catalog-prompt-raw summary { padding-block:var(--s-2); cursor:pointer; }
.catalog-prompt-sources { display:grid; gap:var(--s-3); margin:0; }
.catalog-prompt-sources > div { display:grid; grid-template-columns:5em minmax(0,1fr); gap:var(--s-3); }
.catalog-prompt-sources dt { color:var(--text-secondary); }
.catalog-prompt-sources dd { margin:0; color:var(--text-primary); overflow-wrap:anywhere; }
.catalog-prompt-raw textarea { display:block; width:100%; margin-top:var(--s-2); font-family:var(--font-mono); }
</style>
