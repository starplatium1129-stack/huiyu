<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { copyText } from '@/utils/clipboard'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioCopyButton from '@/components/ui/StudioCopyButton.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import { isBackdropClick, useFluidDialog } from '@/composables/useFluidDialog'
import type { NativeDrawing } from '@/composables/prompt/useNativeDrawing'
import '@/assets/css/director/components/PromptHealthPanel.css'

const props = defineProps<{ drawing: NativeDrawing }>()
const title = computed(() => `${props.drawing.mode.value === 'moss' ? 'MiaoMiao MOSS' : 'Qwen'} 提示词`)
const negative = computed(() => props.drawing.session.value?.turbo.value ? '' : props.drawing.recipe.value.negative)
const readerDialog = ref<HTMLDialogElement | null>(null), readerLoaded = ref(false)
const reader = useFluidDialog(readerDialog)
const copy = () => copyText(props.drawing.recipe.value.prompt)
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
    <header class="native-prompt-heading">
      <h4>{{ title }}</h4>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="!drawing.recipe.value.prompt" aria-label="展开阅读完整提示词" @click="openReader"><ArchiveIcon name="expand" />阅读</button>
    </header>
    <StudioCopyButton class="btn btn-ghost btn-sm" label="复制提示词" :action="copy" :content-key="drawing.recipe.value.prompt" :disabled="!drawing.recipe.value.prompt" />
    <p v-if="drawing.recipe.value.error" role="alert">{{ drawing.recipe.value.error }}</p>
    <p v-if="!drawing.recipe.value.prompt" class="native-prompt-empty">选择场景或填写画面描述后，提示词会在这里更新。</p>
    <p v-else class="native-prompt-text" aria-label="画面提示词">{{ drawing.recipe.value.prompt }}</p>
    <details v-if="negative" class="prompt-preview-details"><StudioDisclosureSummary>负向提示词</StudioDisclosureSummary><p class="native-prompt-text">{{ negative }}</p></details>

    <dialog ref="readerDialog" class="prompt-reader" aria-labelledby="native-prompt-reader-heading" @cancel.prevent="reader.close()" @click="onReaderClick">
      <header class="prompt-reader-heading"><h2 id="native-prompt-reader-heading">{{ title }}</h2><button class="btn btn-quiet btn-icon" type="button" aria-label="关闭提示词阅读" @click="reader.close()"><ArchiveIcon name="close" /></button></header>
      <div class="prompt-reader-content" tabindex="0" role="region" aria-label="提示词正文">
        <div v-if="readerLoaded" class="native-reader-body">
          <p class="native-prompt-text">{{ drawing.recipe.value.prompt }}</p>
          <details v-if="negative" class="prompt-preview-details"><StudioDisclosureSummary>负向提示词</StudioDisclosureSummary><p class="native-prompt-text">{{ negative }}</p></details>
        </div>
      </div>
      <footer class="prompt-reader-actions"><StudioCopyButton class="btn btn-primary" label="复制提示词" :action="copy" :content-key="drawing.recipe.value.prompt" :disabled="!drawing.recipe.value.prompt" /></footer>
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
