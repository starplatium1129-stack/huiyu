<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { copyText } from '@/utils/clipboard'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioCopyButton from '@/components/ui/StudioCopyButton.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import PromptPreviewContent from '@/components/director/PromptPreviewContent.vue'
import PromptTagWorkbench from './PromptTagWorkbench.vue'
import { isBackdropClick, useFluidDialog } from '@/composables/useFluidDialog'
import type { NativeDrawing } from '@/composables/prompt/useNativeDrawing'
import { MOSS_QUALITY } from '@/utils/mossPrompt'
import { promptPreviewScopes, type PromptPreviewLayer } from '@/utils/promptPreview'
import '@/assets/css/director/components/PromptHealthPanel.css'

const props = defineProps<{ drawing: NativeDrawing }>()
const isMoss = computed(() => props.drawing.mode.value === 'moss')
const title = computed(() => `${isMoss.value ? 'MiaoMiao MOSS' : 'Qwen'} 提示词`)
const prompt = computed(() => isMoss.value && !props.drawing.recipe.value.raw.trim() ? '' : props.drawing.recipe.value.prompt)
const negative = computed(() => props.drawing.session.value?.turbo.value ? '' : props.drawing.recipe.value.negative)
const mossScopes = computed<PromptPreviewLayer[][]>(() => {
  const recipe = props.drawing.recipe.value
  if (!isMoss.value || !prompt.value || recipe.error) return []
  const raw = recipe.raw.trim()
  if (raw.startsWith('{')) return [[{
    id: 'prose', number: '01', label: '布局 JSON', empty: '未填写布局', groups: [], prose: recipe.prompt,
  }]]
  const plan = props.drawing.mossPlan.value
  const prefix = recipe.prompt.endsWith(raw) ? recipe.prompt.slice(0, -raw.length).replace(/,\s*$/, '') : ''
  const caption = recipe.tagLine && raw.startsWith(recipe.tagLine)
    ? raw.slice(recipe.tagLine.length).replace(/^\n/, '') : raw
  const tags = [prefix, recipe.tagLine].filter(Boolean).join(', ')
  return promptPreviewScopes(`${tags}\n${caption}`, {
    format: 'anima-tags', qualityTokens: MOSS_QUALITY.split(', '),
    characterTokens: plan?.characterTokens || [],
    copyrightTokens: plan?.copyrightTokens || [], artists: plan?.artists || [],
  })
})
const readerDialog = ref<HTMLDialogElement | null>(null), readerLoaded = ref(false)
const reader = useFluidDialog(readerDialog)
const copy = () => copyText(prompt.value)
async function openReader(event: MouseEvent) {
  const source = event.currentTarget as HTMLElement
  readerLoaded.value = true
  await nextTick()
  if (source.isConnected) reader.open(source)
}
function onReaderClick(event: MouseEvent) { if (isBackdropClick(event, readerDialog.value)) reader.close() }
</script>

<template>
  <section class="native-prompt" aria-label="当前引擎提示词">
    <PromptTagWorkbench v-if="isMoss" prompt-format="moss-hybrid" :model-profile="null" />
    <header class="native-prompt-heading">
      <h4>{{ title }}</h4>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="!prompt" aria-label="展开阅读完整提示词" @click="openReader"><ArchiveIcon name="expand" />阅读</button>
    </header>
    <StudioCopyButton class="btn btn-ghost btn-sm" label="复制提示词" :action="copy" :content-key="prompt" :disabled="!prompt" />
    <p v-if="drawing.recipe.value.error" role="alert">{{ drawing.recipe.value.error }}</p>
    <template v-if="isMoss">
      <PromptPreviewContent :prompt="prompt" :scopes="mossScopes" :negative-text="negative" />
      <details v-if="prompt && !drawing.recipe.value.raw.trim().startsWith('{')" class="prompt-preview-details">
        <StudioDisclosureSummary>完整正向原文</StudioDisclosureSummary><p class="native-prompt-text">{{ prompt }}</p>
      </details>
    </template>
    <template v-else>
      <p v-if="!prompt" class="native-prompt-empty">选择场景或输入描述后生成提示词。</p>
      <p v-else class="native-prompt-text" aria-label="画面提示词">{{ prompt }}</p>
      <details v-if="negative" class="prompt-preview-details"><StudioDisclosureSummary>负向提示词</StudioDisclosureSummary><p class="native-prompt-text">{{ negative }}</p></details>
    </template>

    <dialog ref="readerDialog" class="prompt-reader" aria-labelledby="native-prompt-reader-heading" @cancel.prevent="reader.close()" @click="onReaderClick">
      <header class="prompt-reader-heading"><h2 id="native-prompt-reader-heading">{{ title }}</h2><button class="btn btn-quiet btn-icon" type="button" aria-label="关闭提示词阅读" @click="reader.close()"><ArchiveIcon name="close" /></button></header>
      <div class="prompt-reader-content" tabindex="0" role="region" aria-label="提示词正文">
        <div v-if="readerLoaded" class="native-reader-body">
          <template v-if="isMoss">
            <PromptPreviewContent :prompt="prompt" :scopes="mossScopes" :negative-text="negative" />
            <details v-if="prompt && !drawing.recipe.value.raw.trim().startsWith('{')" class="prompt-preview-details">
              <StudioDisclosureSummary>完整正向原文</StudioDisclosureSummary><p class="native-prompt-text">{{ prompt }}</p>
            </details>
          </template>
          <template v-else>
            <p class="native-prompt-text">{{ prompt }}</p>
            <details v-if="negative" class="prompt-preview-details"><StudioDisclosureSummary>负向提示词</StudioDisclosureSummary><p class="native-prompt-text">{{ negative }}</p></details>
          </template>
        </div>
      </div>
      <footer class="prompt-reader-actions"><StudioCopyButton class="btn btn-primary" label="复制提示词" :action="copy" :content-key="prompt" :disabled="!prompt" /></footer>
    </dialog>
  </section>
</template>

<style scoped>
.native-prompt { display:grid; gap:var(--s-3); min-width:0; }
.native-prompt-heading { display:flex; align-items:center; justify-content:space-between; gap:var(--s-3); min-width:0; }
.native-prompt-heading h4 { margin:0; color:var(--text-primary); font-size:var(--fs-label); overflow-wrap:anywhere; }
.native-prompt-heading .btn { flex:none; }
.native-prompt p { margin:0; color:var(--text-secondary); font-size:var(--fs-label); line-height:var(--lh-body); }
.native-prompt .native-prompt-text { color:var(--text-primary); white-space:pre-wrap; overflow-wrap:anywhere; user-select:text; }
.native-prompt > .btn { justify-self:start; }
.native-reader-body { max-width:80ch; margin-inline:auto; font-size:var(--fs-label); }
</style>
