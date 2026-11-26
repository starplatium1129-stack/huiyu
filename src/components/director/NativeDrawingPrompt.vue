<script setup lang="ts">
import { computed, nextTick, ref, useId } from 'vue'
import { copyText } from '@/utils/clipboard'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioCopyButton from '@/components/ui/StudioCopyButton.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import PromptTagWorkbench from './PromptTagWorkbench.vue'
import { isBackdropClick, useFluidDialog } from '@/composables/useFluidDialog'
import { isMossLayoutInput } from '@/utils/mossLayout'
import type { NativeDrawing } from '@/composables/prompt/useNativeDrawing'
import '@/assets/css/director/components/PromptHealthPanel.css'

const props = defineProps<{ drawing: NativeDrawing }>()
const isMoss = computed(() => props.drawing.mode.value === 'moss')
const prompt = computed(() => props.drawing.recipe.value.prompt)
const isLayout = computed(() => isMoss.value && isMossLayoutInput(prompt.value))
const title = computed(() => isMoss.value ? (isLayout.value ? 'MOSS 布局' : 'MOSS 提示词') : 'Qwen 提示词')
const hasOverride = computed(() => !!props.drawing.mossLayout.value || props.drawing.usingMossTaskPrompt.value)
const staleLayout = computed(() => isMoss.value && props.drawing.staleMossLayout.value)
const negative = computed(() => props.drawing.session.value?.turbo.value ? '' : props.drawing.recipe.value.negative)
const readerDialog = ref<HTMLDialogElement | null>(null), readerLoaded = ref(false)
const editor = ref<HTMLTextAreaElement | null>(null), editing = ref(false)
const draft = ref(''), editError = ref(''), editorId = useId(), readerTitleId = useId()
const reader = useFluidDialog(readerDialog)
const copy = () => copyText(prompt.value)
async function openReader(event: MouseEvent, edit = false) {
  const source = event.currentTarget as HTMLElement
  editing.value = edit
  if (edit) {
    editError.value = ''
    try { draft.value = props.drawing.mossLayoutDraft(staleLayout.value) }
    catch (cause) {
      draft.value = ''
      editError.value = cause instanceof Error ? cause.message : '布局草稿无法准备'
    }
  }
  readerLoaded.value = true
  await nextTick()
  if (source.isConnected) reader.open(source)
}
async function applyLayout(automatic = false) {
  try {
    if (!automatic && !draft.value.trim()) throw new Error('请填写 JSON 布局')
    props.drawing.applyMossLayout(automatic ? '' : draft.value)
    reader.close()
  } catch (cause) {
    editError.value = cause instanceof Error ? cause.message : '布局无法应用'
    await nextTick()
    editor.value?.focus()
  }
}
function onReaderClick(event: MouseEvent) { if (isBackdropClick(event, readerDialog.value)) reader.close() }
</script>

<template>
  <section class="native-prompt" aria-label="当前引擎提示词">
    <PromptTagWorkbench v-if="isMoss && !hasOverride" prompt-format="moss-layout" :model-profile="null" />
    <header class="native-prompt-heading">
      <h4>{{ title }}</h4>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="!prompt" aria-label="展开阅读完整提示词" @click="openReader($event)"><ArchiveIcon name="expand" />阅读</button>
    </header>
    <div class="native-prompt-actions">
      <StudioCopyButton class="btn btn-ghost btn-sm" label="复制提示词" :action="copy" :content-key="prompt" :disabled="!prompt" />
      <button v-if="isMoss" class="btn btn-ghost btn-sm" type="button" :disabled="drawing.locked.value" @click="openReader($event, true)">{{ staleLayout ? '按当前设置重排' : '编辑布局' }}</button>
      <button v-if="staleLayout" class="btn btn-quiet btn-sm" type="button" :disabled="drawing.locked.value" @click="drawing.applyMossLayout('')">清除手工布局</button>
    </div>
    <p v-if="staleLayout" role="status">角色、阵型或画幅已变化。原手工布局仍已保存，请重排或清除后继续绘制。</p>
    <p v-if="drawing.recipe.value.error" role="alert">{{ drawing.recipe.value.error }}</p>
    <p v-else-if="!prompt">选择场景或输入画面描述<span v-if="isMoss">，也可直接编辑布局</span>。</p>
    <template v-else>
      <p v-if="hasOverride">{{ drawing.usingMossTaskPrompt.value ? '正在使用原任务提示词' : '已应用自定义布局' }}。要采用工作台的反推词或随机灵感，请在「编辑布局」中选择「恢复自动提示词」。</p>
      <pre v-if="isLayout" class="native-layout-json" aria-label="发送给 MOSS 的布局">{{ prompt }}</pre>
      <p v-else class="native-prompt-text" aria-label="画面提示词">{{ prompt }}</p>
    </template>
    <details v-if="negative && (!isMoss || prompt)" class="prompt-preview-details"><StudioDisclosureSummary>负向提示词</StudioDisclosureSummary><p class="native-prompt-text">{{ negative }}</p></details>

    <dialog ref="readerDialog" class="prompt-reader" :aria-labelledby="readerTitleId" @cancel.prevent="reader.close()" @click="onReaderClick">
      <header class="prompt-reader-heading"><h2 :id="readerTitleId">{{ editing ? '编辑 MOSS 布局' : title }}</h2><button class="btn btn-quiet btn-icon" type="button" aria-label="关闭提示词窗口" @click="reader.close()"><ArchiveIcon name="close" /></button></header>
      <form v-if="editing" :id="editorId + '-form'" class="prompt-reader-content" novalidate @submit.prevent="applyLayout()">
        <div class="native-layout-editor">
          <label :for="editorId">布局 JSON</label>
          <p :id="`${editorId}-help`">当前画幅 {{ drawing.size.value.replace('x', ' × ') }}。原生 bbox 使用中心原点和 [上, 左, 下, 右]。也可粘贴带宽高的像素草稿。自定义坐标随原稿保留。</p>
          <textarea :id="editorId" ref="editor" v-model="draft" name="layout" class="textarea" rows="14"
            required spellcheck="false" autocorrect="off" autocapitalize="off" autofocus
            :aria-invalid="editError ? 'true' : undefined" :aria-describedby="`${editorId}-help${editError ? ` ${editorId}-error` : ''}`"
            @input="editError = ''" />
          <p :id="`${editorId}-error`" class="native-layout-error">{{ editError }}</p>
        </div>
      </form>
      <div v-else class="prompt-reader-content" tabindex="0" role="region" aria-label="提示词正文">
        <div v-if="readerLoaded" class="native-reader-body">
          <pre v-if="isLayout" class="native-layout-json">{{ prompt }}</pre>
          <p v-else class="native-prompt-text">{{ prompt }}</p>
          <details v-if="negative" class="prompt-preview-details"><StudioDisclosureSummary>负向提示词</StudioDisclosureSummary><p class="native-prompt-text">{{ negative }}</p></details>
        </div>
      </div>
      <footer class="prompt-reader-actions">
        <template v-if="editing">
          <button v-if="hasOverride" class="btn btn-quiet" type="button" @click="applyLayout(true)">恢复自动提示词</button>
          <button class="btn btn-ghost" type="button" @click="reader.close()">取消</button>
          <button class="btn btn-primary" type="submit" :form="editorId + '-form'">应用布局</button>
        </template>
        <StudioCopyButton v-else class="btn btn-primary" label="复制提示词" :action="copy" :content-key="prompt" :disabled="!prompt" />
      </footer>
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
.native-prompt-actions { display:flex; flex-wrap:wrap; gap:var(--s-2); }
.native-layout-json { margin:0; padding:var(--s-3); border-radius:var(--r-md); background:var(--bg-elevated); color:var(--text-primary); font:400 var(--fs-label)/var(--lh-body) var(--font-mono); white-space:pre-wrap; overflow-wrap:anywhere; user-select:text; }
.native-layout-editor { display:grid; gap:var(--s-2); }
.native-layout-editor label { color:var(--text-primary); font-size:var(--fs-label); }
.native-layout-editor textarea { font-family:var(--font-mono); }
.native-layout-editor .native-layout-error { color:var(--danger-text); }
.native-layout-error:empty { display:none; }
.native-reader-body { max-width:80ch; margin-inline:auto; font-size:var(--fs-label); }
</style>
