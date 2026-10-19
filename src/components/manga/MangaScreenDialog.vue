<template>
  <Teleport to="body">
    <dialog ref="dialog" class="manga-dialog" aria-labelledby="manga-title" aria-describedby="manga-description" @cancel.prevent="requestClose" @keydown.stop>
      <header class="manga-heading">
        <div><h2 id="manga-title"><ArchiveIcon name="book" />漫画化 <span class="manga-validation">待主力机验证</span></h2>
          <p id="manga-description">把已有图片处理成黑白网点漫画，或单独提取线稿，另存为新作品。</p></div>
        <button class="btn btn-quiet btn-icon" type="button" aria-label="关闭漫画化窗口" @click="requestClose"><ArchiveIcon name="close" /></button>
      </header>
      <div class="manga-body">
        <section class="manga-canvas" aria-label="漫画预览">
          <div class="manga-preview-bar">
            <div class="studio-segments" role="group" aria-label="预览方式"><AnimatedSelection />
              <button v-for="view in views" :key="view.value" type="button" :class="{active:preview === view.value}" :aria-pressed="preview === view.value"
                :disabled="view.value === 'original' ? !source : view.value === 'lineart' ? !linePreviewAvailable : view.value === 'compare' ? !source || !resultUrl : !result" @click="preview = view.value">{{ view.label }}</button>
            </div>
            <button ref="importButton" class="btn btn-ghost btn-sm" type="button" :disabled="locked" @click="picker?.click()"><ArchiveIcon name="upload" />{{ source ? '换一张' : '导入图片' }}</button>
            <input ref="picker" type="file" class="manga-file" accept="image/png,image/jpeg,image/webp" @change="pickImage" />
            <div v-if="preview === 'lineart'" class="manga-line-preview-bar">
              <StudioSelect v-if="lineChoices.length > 1" v-model="lineSelected" label="查看哪张线稿" :options="lineChoices" size="sm" inline />
              <span v-else>{{ lineChoices[0]?.label }}</span>
              <div class="manga-line-actions">
                <button class="btn btn-ghost btn-sm" type="button" :disabled="locked || !linePreviewUrl" @click="lines.download"><ArchiveIcon name="download" />导出线稿 PNG</button>
                <button class="btn btn-ghost btn-sm" type="button" :disabled="lineSaveDisabled" @click="lines.save"><ArchiveIcon name="gallery" />{{ lineSaved ? '已存入我的作品' : '存入我的作品' }}</button>
              </div>
            </div>
          </div>
          <div class="manga-stage" :class="{'has-image':!!sourcePreviewUrl}">
            <ImageCompareSlider v-if="preview === 'compare' && resultUrl" :before-src="sourcePreviewUrl" :after-src="resultUrl" before-label="原图" after-label="漫画副本" />
            <template v-else-if="preview === 'lineart'">
              <ZoomableImageViewer v-if="linePreviewUrl" :src="linePreviewUrl" :alt="lineCaption + '，黑线白底'" />
              <div v-else class="manga-empty"><ArchiveIcon name="book" /><h3>{{ lineLoading ? '正在读取线稿…' : '线稿尚未读取' }}</h3>
                <p>{{ lineSelected === 'output' ? '重新读取已生成的线稿，无需再次运行模型。' : '请按原文件黑白极性生成线稿预览。' }}</p>
                <button class="btn btn-ghost" type="button" :disabled="locked" @click="lineSelected === 'output' ? lines.readOutput() : retryImportedLine()">重新读取线稿</button>
              </div>
            </template>
            <ZoomableImageViewer v-else-if="preview === 'result' ? resultUrl : sourcePreviewUrl" :src="preview === 'original' ? sourcePreviewUrl : resultUrl" :alt="preview === 'original' ? '漫画处理原图' : '漫画处理结果'" />
            <div v-else class="manga-empty"><ArchiveIcon name="book" /><h3>{{ preview === 'result' && result ? '漫画预览尚未读取' : loading ? '正在读取原图…' : '从一张画开始' }}</h3>
              <p v-if="preview === 'result' && result">结果已保存在任务中，可直接入册，或重新读取预览后导出 PNG。</p>
              <p v-else>导入 PNG、JPEG 或 WebP 图片<br />调整明暗、网点与纸张，留下漫画质感。</p>
              <button class="btn btn-primary" type="button" :disabled="locked" @click="picker?.click()">选择图片</button>
              <button v-if="error && (props.sourceUrl || props.artwork?.image_id)" class="btn btn-ghost" type="button" :disabled="locked" @click="loadInitialSource">重新读取原图</button>
            </div>
          </div>
          <div class="manga-caption">
            <span v-if="preview === 'lineart'">{{ lineCaption }} · 黑线白底 · 待主力机验证</span>
            <span v-else-if="source">{{ source.name }} · {{ source.width }} × {{ source.height }}</span>
            <span v-else>单张静态图片 · 文件不超过 16 MB</span>
            <span v-if="preview === 'lineart' && lineSelected === 'output' && lineDirty">这是上一次线稿结果，新任务或漫画参数不会改写这张预览</span>
            <span v-else-if="preview !== 'lineart' && dirty">当前漫画为上一次结果；新参数需重新处理</span>
            <span v-else-if="!result && preview !== 'lineart'">调好参数后点击「处理为漫画」查看实际结果</span>
          </div>
        </section>
        <aside class="manga-controls" aria-label="漫画处理设置">
          <section class="manga-readiness" :aria-busy="checking">
            <div><strong>{{ checking ? '正在读取服务状态…' : status?.available ? '原生漫画处理' : '漫画服务尚未就绪' }}</strong>
              <button class="btn btn-quiet btn-sm" type="button" :disabled="checking || submitting || pending" @click="refreshStatus">重新检查</button></div>
            <p>{{ taskIssue || (status?.available ? '文件已就位，依赖与效果仍待主力机验证。' : '需要已配置的原生后端与独立漫画处理环境。') }}</p>
            <details v-if="statusError || status?.unavailableReason"><StudioDisclosureSummary>查看原因</StudioDisclosureSummary><p data-disclosure-content>{{ statusError || status?.unavailableReason }}</p></details>
          </section>
          <div v-if="inputSize?.resized" class="manga-resize">
            <StudioCheckbox :checked="resize" :disabled="locked" label="缩小处理副本" @update:checked="resize = $event">缩小处理副本</StudioCheckbox>
            <p>本次按 {{ inputSize.width }} × {{ inputSize.height }} 处理，以满足约 200 万像素上限。原图保留。</p>
          </div>
          <MangaModels v-model:redraw="redraw" :external-lines="lineMode === 'external'" :rewrite="rewrite" :status="status" :issue="modelIssue" :disabled="locked" />
          <MangaLineControls v-model:mode="lineMode" v-model:polarity="linePolarity" v-model:stretch="lineStretch" :redraw="redraw" :disabled="locked"
            :status="status" :imported="lineImported" :target-size="inputSize" :mismatch="lineMismatch" :input-ready="lineInputReady" :issue="lineIssue"
            :extraction-issue="extractionIssue" @extract="run('lineart')" @import="importLine" @remove="lines.remove" @preview="showImportedLine" @retry="retryImportedLine" />
          <MangaParameters v-model:operation="operation" :parameters="parameters" :disabled="locked" @reset="resetParameters" />
          <details class="manga-scope"><StudioDisclosureSummary>当前支持范围</StudioDisclosureSummary><p data-disclosure-content>已接入 Qwen 单图漫画重绘、自动线稿、独立提取、外部线稿、预览、PNG 导出和作品库保存，以及色阶、网点、裁切与纸张，均待主力机验证。漫画附带的线稿保留裁框前尺寸。已接收任务和结果保存在任务中心；重启可找回已保存结果、继续尚未提交的排队任务。已开始的推理不支持断点续算，中断会明确提示。暂不支持多格排版、文字气泡与批处理。</p></details>
        </aside>
      </div>
      <footer class="manga-footer">
        <div class="manga-feedback" aria-live="polite">
          <p v-if="exporting">正在保存图片…</p>
          <p v-else-if="lineLoading">正在读取线稿…</p>
          <p v-else-if="submitting || pending || observing">{{ notice || (submitting ? '正在准备并提交图片…' : job?.progressText || '正在读取任务…') }}<span v-if="progress !== null"> · {{ progress }}%</span></p>
          <p v-else-if="lineNotice && preview === 'lineart'">{{ lineNotice }}</p><p v-else-if="notice">{{ notice }}</p><p v-else>已接收任务由后台继续处理，关闭窗口后可在任务中心查看</p>
          <p v-if="error" class="manga-error" role="alert">{{ error }}</p>
          <p v-if="lineError" class="manga-error" role="alert">{{ lineError }}</p>
          <span v-if="job && error" class="manga-job-id">任务 {{ job.id }}</span>
          <span v-if="lineError && lineExpected" class="manga-job-id">线稿任务 {{ lineExpected.id }}</span>
        </div>
        <div class="manga-actions">
          <button class="btn btn-ghost" type="button" :disabled="exporting" @click="openTasks">任务中心</button>
          <button v-if="canStartNew" class="btn btn-ghost" type="button" @click="beginNew">开始新的处理</button>
          <button v-if="!observing && !submitting && (acceptanceUnknown || job)" class="btn btn-ghost" type="button" @click="observe">{{ acceptanceUnknown ? '查询接收状态' : job?.status === 'succeeded' ? '重新读取结果' : '重新连接原任务' }}</button>
          <button v-if="pending || submitting || acceptanceUnknown" class="btn btn-ghost" type="button" :disabled="cancelling" @click="cancel">{{ cancelling ? '请求取消…' : '取消处理' }}</button>
          <button v-if="result" class="btn btn-ghost" type="button" :disabled="locked || !resultBlob" @click="exportResult('download')"><ArchiveIcon name="download" />导出漫画 PNG</button>
          <button v-if="result" class="btn btn-ghost" type="button" :disabled="saveLocked || saved" @click="exportResult('save')"><ArchiveIcon name="gallery" />{{ saved ? '已存入我的作品' : '另存到我的作品' }}</button>
          <button class="btn btn-primary" type="button" :disabled="locked || !source || !status?.available || !!taskIssue || !!modelIssue || !!lineIssue || !!inputSize?.resized && !resize" @click="run('manga')"><ArchiveIcon name="spark" />{{ submitting || pending ? '处理中…' : result ? '重新处理漫画' : '处理为漫画' }}</button>
        </div>
      </footer>
    </dialog>
  </Teleport>
</template>
<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import ZoomableImageViewer from '@/components/visual/ZoomableImageViewer.vue'
import ImageCompareSlider from '@/components/visual/ImageCompareSlider.vue'
import StudioCheckbox from '@/components/ui/StudioCheckbox.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import MangaParameters from './MangaParameters.vue'
import MangaModels from './MangaModels.vue'
import MangaLineControls from './MangaLineControls.vue'
import { useFluidDialog } from '@/composables/useFluidDialog'
import { useTaskCenter } from '@/composables/useTaskCenter'
import { useMangaScreen } from '@/composables/manga/useMangaScreen'
import { confirmAction } from '@/composables/useConfirm'
import { defaultMangaParameters } from '@/api/mangaApi'
import type { ArtworkRecord } from '@/types/artwork'

const props = defineProps<{ sourceUrl?: string; artwork?: ArtworkRecord; opener: HTMLElement | null }>()
const emit = defineEmits<{ closed: []; saved: [] }>()
const dialog = ref<HTMLDialogElement | null>(null), picker = ref<HTMLInputElement | null>(null)
const importButton = ref<HTMLButtonElement | null>(null)
const fluid = useFluidDialog(dialog)
const taskCenter = useTaskCenter()
const { parameters, operation, redraw, rewrite, modelIssue, lines, lineLoading, lineMismatch, lineIssue, lineDirty, extractionIssue, importLine, source, sourceUrl: sourcePreviewUrl, resize, inputSize, result, resultBlob, resultUrl, status, statusError, checking,
  error, notice, loading, submitting, observing, cancelling, exporting, saved, acceptanceUnknown, job, preview, taskIssue,
  pending, locked, saveLocked, dirty, progress, refreshStatus, loadSource, restoreRequest, canStartNew, startNew, observe, cancel, run, exportResult } = useMangaScreen(() => emit('saved'))
const {mode:lineMode, polarity:linePolarity, stretch:lineStretch, imported:lineImported, inputReady:lineInputReady,
  selected:lineSelected, previewUrl:linePreviewUrl, previewAvailable:linePreviewAvailable, caption:lineCaption,
  choices:lineChoices, error:lineError, notice:lineNotice, saved:lineSaved, saveDisabled:lineSaveDisabled, expected:lineExpected} = lines
const views = [{value:'original',label:'原图'},{value:'lineart',label:'线稿'},{value:'result',label:'漫画'},{value:'compare',label:'对比'}] as const
async function beginNew(event: MouseEvent) {
  const origin = event.currentTarget as HTMLButtonElement
  const ownedFocus = document.activeElement === origin
  await startNew()
  await nextTick()
  if (ownedFocus && !origin.isConnected && dialog.value?.open
    && (document.activeElement === document.body || document.activeElement === dialog.value))
    importButton.value?.focus({ preventScroll: true })
}
function showImportedLine() { lineSelected.value = 'input'; preview.value = 'lineart' }
async function retryImportedLine() { if (await lines.prepare()) showImportedLine() }
let closing = false
async function mayClose() {
  if (exporting.value) { error.value = '正在保存，请稍候再关闭'; return false }
  if (lines.unsaved.value) return confirmAction({title:'导入线稿保存尚未确认',message:'导入的线稿预览尚未确认入册，可先重试保存或导出 PNG。已接收的任务与结果会保留在任务中心。',confirmLabel:'关闭',cancelLabel:'继续查看'})
  return true
}
async function openTasks() {
  if (closing) return
  closing = true
  try { if (await mayClose()) fluid.close(() => { emit('closed'); taskCenter.openRuntimeTasks() }) }
  finally { closing = false }
}
async function requestClose() {
  if (closing) return
  closing = true
  try { if (await mayClose()) fluid.close(() => emit('closed')) } finally { closing = false }
}
onBeforeRouteLeave(async () => { const allowed = await mayClose(); if (allowed) fluid.close(() => emit('closed')); return allowed })
function resetParameters() { Object.assign(parameters, defaultMangaParameters()) }
async function pickImage(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]; input.value = ''
  if (!file || locked.value) return
  if (lines.unsaved.value && !await confirmAction({title:'更换图片？',message:'导入线稿保存尚未确认，更换后将释放导入预览；已接收的任务与结果会保留。',confirmLabel:'更换图片',cancelLabel:'保留当前'})) return
  await loadSource(file)
}
onMounted(() => {
  fluid.open(props.opener)
  void refreshStatus()
  if (restoreRequest()) { void observe(); return }
  if (props.sourceUrl || props.artwork?.image_id) void loadInitialSource()
})
function loadInitialSource() { return loadSource({url:props.sourceUrl || '', artwork:props.artwork}) }
</script>
<style src="@/assets/css/manga-screen.css"></style>
