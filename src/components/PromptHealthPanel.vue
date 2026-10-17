<template>
  <section class="advanced-decision prompt-health-panel" id="promptMonitor" aria-labelledby="prompt-preview-heading">
    <header class="prompt-preview-heading">
      <div class="prompt-preview-title"><span class="prompt-preview-mark"><ArchiveIcon name="spark" /></span><h3 id="prompt-preview-heading">提示词预览</h3></div>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="!prompt" aria-label="展开阅读完整提示词" @click="reader.open()"><ArchiveIcon name="expand" />阅读</button>
    </header>
    <p class="prompt-health-status" :class="report.level">{{ report.label }}</p>
    <div class="prompt-preview-actions">
      <StudioCopyButton class="btn btn-primary" label="复制提示词" :action="copyAction" :content-key="prompt" :disabled="!prompt" />
      <button class="btn btn-ghost" type="button" @click="emit('save')">保存草稿</button>
    </div>
    <ul v-if="warnings.length" class="prompt-health-warnings" aria-label="提示词优化建议">
      <li v-for="warning in warnings" :key="warning">{{ warning }}</li>
    </ul>
    <PromptPreviewContent :prompt="prompt" :context="context" :positive-count="report.positiveCount" :negative-count="report.negativeCount" />
    <details v-if="modelName || loraText" class="prompt-preview-details">
      <StudioDisclosureSummary>模型信息</StudioDisclosureSummary>
      <dl class="prompt-model-info">
        <div v-if="modelName"><dt>基础模型</dt><dd>{{ modelName }}</dd></div>
        <div v-if="loraText"><dt>LoRA</dt><dd>{{ loraText }}</dd></div>
      </dl>
    </details>
    <dialog ref="readerDialog" class="prompt-reader" aria-labelledby="prompt-reader-heading" @cancel.prevent="reader.close()" @click="onReaderClick">
      <header class="prompt-reader-heading"><h2 id="prompt-reader-heading">完整提示词</h2><button class="btn btn-quiet btn-icon" type="button" aria-label="关闭提示词阅读" @click="reader.close()"><ArchiveIcon name="close" /></button></header>
      <div class="prompt-reader-content" tabindex="0" role="region" aria-label="提示词正文"><PromptPreviewContent :prompt="prompt" :context="context" :positive-count="report.positiveCount" :negative-count="report.negativeCount" /></div>
      <footer class="prompt-reader-actions"><StudioCopyButton class="btn btn-primary" label="复制提示词" :action="copyAction" :content-key="prompt" :disabled="!prompt" /><button class="btn btn-ghost" type="button" @click="emit('save')">保存草稿</button></footer>
    </dialog>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import StudioCopyButton from '@/components/ui/StudioCopyButton.vue'
import PromptPreviewContent from '@/components/director/PromptPreviewContent.vue'
import { isBackdropClick, useFluidDialog } from '@/composables/useFluidDialog'
import type { PromptReport } from '@/utils/promptPolicy'
import type { PromptPreviewContext } from '@/utils/promptPreview'

const props = defineProps<{
  prompt: string
  copyAction: () => Promise<boolean>
  context: PromptPreviewContext
  modelName?: string
  report: PromptReport
  artViolations: string[]
  loraText?: string
}>()

const emit = defineEmits<{
  save: []
}>()

const readerDialog = ref<HTMLDialogElement | null>(null)
const reader = useFluidDialog(readerDialog)
function onReaderClick(event: MouseEvent) { if (isBackdropClick(event, readerDialog.value)) reader.close() }
const warnings = computed(() => {
  const result = [...props.report.warnings]
  if (props.artViolations.length && !result.some(item => item.startsWith('违反美术规范'))) {
    result.push(`违反美术规范：${props.artViolations.join(', ')}`)
  }
  return [...new Set(result)]
})
</script>
