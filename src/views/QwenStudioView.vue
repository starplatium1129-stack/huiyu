<template>
  <article class="qwen-studio">
    <header class="qwen-heading">
      <div><h1>{{ title }}</h1><p>{{ introduction }}</p></div>
      <nav aria-label="图像创作导航"><RouterLink class="btn btn-ghost" to="/prompt-builder">绘图画室</RouterLink><RouterLink class="btn btn-ghost" to="/gallery">我的作品</RouterLink><button class="btn btn-ghost" type="button" @click="openTasks">任务中心</button></nav>
    </header>
    <div class="qwen-layout">
      <section class="qwen-canvas" aria-label="图像预览">
        <div class="qwen-toolbar"><div v-if="!moss" class="studio-segments" role="group" aria-label="预览图片"><AnimatedSelection />
          <button type="button" :class="{ active: preview === 'result' }" :aria-pressed="preview === 'result'" @click="preview = 'result'">生成结果</button>
          <button type="button" :class="{ active: preview === 'source' }" :aria-pressed="preview === 'source'" :disabled="!sourceUrl" @click="referencePreview = ''; preview = 'source'">输入图片</button>
        </div><strong v-else>生成结果</strong><span v-if="result && preview === 'result'">{{ result.input.width }} × {{ result.input.height }}</span></div>
        <div class="qwen-stage">
          <ZoomableImageViewer v-if="preview === 'source' ? previewInputUrl : resultUrl" :src="preview === 'source' ? previewInputUrl : resultUrl" :alt="preview === 'source' ? '编辑输入图片' : title + '生成结果'" />
          <div v-else class="qwen-empty"><ArchiveIcon name="image" /><h2>{{ result ? '结果已保存在任务中' : '从一句描述开始' }}</h2><p>{{ result ? '可直接存入作品册，或刷新预览。' : moss ? '填写画面描述，确认画幅后生成图片。' : '填写画面描述，再点击生成。编辑已有图片时，先导入原图。' }}</p></div>
        </div>
        <p v-if="result && task?.taskId !== result.taskId">这里保留的是上一次结果，新任务不会覆盖已保存的图片。</p>
        <div class="qwen-toolbar"><button v-if="!moss" class="btn btn-primary" type="button" :disabled="!resultBlob || locked" @click="editResult"><ArchiveIcon name="inpaint" />用当前结果继续编辑</button><button class="btn btn-ghost" type="button" :disabled="!result || saving || busy || importing || saved" @click="exportResult('save')"><ArchiveIcon name="gallery" />{{ saved ? '已存入我的作品' : '存入我的作品' }}</button><button class="btn btn-ghost" type="button" :disabled="!resultBlob || saving || busy || importing" @click="exportResult('download')"><ArchiveIcon name="download" />导出 PNG</button></div>
      </section>
      <form class="qwen-controls" @submit.prevent="run">
        <section class="qwen-readiness" aria-label="模型准备状态">
          <div class="qwen-toolbar"><strong>{{ selected?.available ? '模型文件已就绪' : '准备 ' + (moss ? 'MOSS' : 'Qwen') + ' 模型' }}</strong><button class="btn btn-quiet btn-sm" type="button" :disabled="checking || busy" @click="refresh">{{ checking ? '检查中…' : '重新检查' }}</button></div>
          <p>{{ statusError || selected?.unavailableReason || (moss ? '作者建议 30–50 步、CFG 3.5；默认采用 50 步。首次准备需下载约 27.2 GB 模型组件。' : '填写画面描述即可开始，也可以导入原图及最多三张参考图进行编辑。') }}</p>
          <RouterLink v-if="!selected?.available" class="btn btn-ghost btn-sm" :to="{ path: '/control', query: { engine: 'native', model: form.modelId } }">前往控制室准备</RouterLink>
        </section>
        <div class="qwen-field"><label for="qwen-model">模型</label><StudioSelect id="qwen-model" v-model="form.modelId" :label="title + '模型'" :options="modelOptions" :disabled="locked" /></div>
        <div class="qwen-field"><label for="qwen-prompt">{{ source ? '编辑指令' : '画面描述' }}</label><textarea class="textarea" id="qwen-prompt" v-model="form.prompt" rows="5" maxlength="12000" :disabled="locked" :aria-describedby="moss ? 'moss-prompt-help' : undefined" :placeholder="source ? '描述要改变的部分，以及需要保留的内容' : '描述主体、构图、环境与光线'" /></div>
        <p v-if="moss" id="moss-prompt-help" class="qwen-hint">布局 JSON 按原文提交，坐标需匹配当前宽高；带字画面请移除负向中的 text、english text。当前支持 FP16 权重的文生图。</p>
        <section v-if="!moss" class="qwen-source" aria-label="可选编辑原图">
          <div class="qwen-toolbar"><button ref="sourceButton" class="btn btn-ghost btn-sm" type="button" :disabled="locked" @click="picker?.click()"><ArchiveIcon name="upload" />{{ source ? '更换原图' : '导入编辑原图' }}</button><button v-if="source || restoredInputMissing" class="btn btn-quiet btn-sm" type="button" :disabled="locked" @click="clearSources">移除输入，改为文生图</button></div>
          <input ref="picker" type="file" hidden accept="image/png,image/jpeg,image/webp" @change="pick" />
          <p v-if="source">图 1 · {{ source.name }} · {{ source.width }} × {{ source.height }}</p><p v-else>可选 · PNG、JPEG、WebP · 每张最大 16 MB</p>
          <template v-if="source">
            <button ref="referenceButton" class="btn btn-ghost btn-sm" type="button" :disabled="locked || references.length >= 3" @click="referencePicker?.click()"><ArchiveIcon name="upload" />添加参考图（{{ references.length }} / 3）</button>
            <input ref="referencePicker" type="file" hidden multiple accept="image/png,image/jpeg,image/webp" @change="pickReferences" />
            <TransitionGroup v-if="references.length" tag="ol" name="qwen-reference" class="qwen-references" aria-label="参考图顺序" start="2" @before-leave="retireReference">
              <li v-for="(value, index) in references" :key="value.id"><button class="btn btn-quiet btn-sm" type="button" :aria-label="`预览图 ${index + 2}：${value.image.name}`" @click="referencePreview = value.id; preview = 'source'">图 {{ index + 2 }} · {{ value.image.name }}</button><span class="qwen-reference-actions"><button class="btn btn-quiet btn-sm" type="button" :disabled="locked || index === 0" :aria-label="`前移图 ${index + 2}`" @click="reorderReference(value.id, -1, $event)">前移</button><button class="btn btn-quiet btn-sm" type="button" :disabled="locked || index === references.length - 1" :aria-label="`后移图 ${index + 2}`" @click="reorderReference(value.id, 1, $event)">后移</button><button class="btn btn-quiet btn-sm" type="button" :disabled="locked" :aria-label="`移除图 ${index + 2}：${value.image.name}`" @click="dropReference(value.id)">移除</button></span></li>
            </TransitionGroup>
            <p>按显示顺序提供图片；可在指令中用「图 1」「图 2」指定用途。</p>
          </template>
          <StudioCheckbox v-if="needsResize" v-model:checked="resize" :disabled="locked" label="缩小超限输入图片副本">按处理上限缩小超限图片的副本，保留本地原文件</StudioCheckbox>
        </section>
        <div class="qwen-pair"><div class="qwen-field"><label for="qwen-width">宽度（px）</label><input class="input" id="qwen-width" v-model.number="form.width" type="number" min="512" :max="maxSize" :step="alignment" :disabled="locked" aria-describedby="qwen-size-help" /></div><div class="qwen-field"><label for="qwen-height">高度（px）</label><input class="input" id="qwen-height" v-model.number="form.height" type="number" min="512" :max="maxSize" :step="alignment" :disabled="locked" aria-describedby="qwen-size-help" /></div></div>
        <p id="qwen-size-help" class="qwen-hint">每边 512–{{ maxSize }} px，为 {{ alignment }} 的倍数。大画幅会增加显存与内存占用。</p>
        <details class="qwen-advanced"><StudioDisclosureSummary>高级参数 · {{ turbo ? '8 步 · CFG 1' : `${form.steps} 步` }} · {{ randomSeed ? '随机种子' : '固定种子' }}</StudioDisclosureSummary><div class="qwen-advanced-body"><template v-if="!turbo">
          <div class="qwen-field"><label for="qwen-negative">负向描述（可选）</label><textarea class="textarea" id="qwen-negative" v-model="form.negative" rows="2" maxlength="8000" :disabled="locked" /></div>
          <div v-if="moss" class="qwen-field">
            <label for="moss-acceleration">缓存加速</label>
            <StudioSelect id="moss-acceleration" v-model="form.mossAcceleration" label="MOSS 缓存加速" :disabled="locked" :options="[{ value: 'off', label: '关闭 · 完整计算' }, { value: 'spectrum', label: 'Spectrum · 实验', disabled: !selected?.mossSpectrum }]" />
            <p class="qwen-hint">Spectrum 可跳过部分计算，可能改变画面细节并额外占用显存。当前尚未实机验证；显存余量不足时使用完整计算。</p>
          </div>
          <div class="qwen-pair"><div class="qwen-field"><label for="qwen-steps">步数</label><input class="input" id="qwen-steps" v-model.number="form.steps" type="number" min="1" max="100" :disabled="locked" /></div><div v-if="moss || form.negative.trim()" class="qwen-field"><label for="qwen-cfg">CFG</label><input class="input" id="qwen-cfg" v-model.number="form.cfg" type="number" :min="moss ? 0 : 1.1" max="20" step="0.1" :disabled="locked" /></div></div>
        </template>
        <p v-else class="qwen-hint">Turbo 使用固定 8 步、CFG 1，无负向描述。</p>
        <StudioCheckbox v-model:checked="randomSeed" :disabled="locked" label="每次随机种子">每次随机种子</StudioCheckbox>
        <div v-if="!randomSeed" class="qwen-field"><label for="qwen-seed">种子</label><input class="input" id="qwen-seed" v-model.number="form.seed" type="number" min="0" max="2147483647" step="1" :disabled="locked" /></div>
        </div></details><p v-if="selected" class="qwen-hint"><a :href="selected.licenseUrl" target="_blank" rel="noopener noreferrer">查看当前模型使用许可</a></p>
        <p v-if="parentId !== null" class="qwen-hint">此编辑保留来源作品关联；将来源与结果入册后，可在作品册查看修改历史与对比。</p><div class="qwen-feedback" aria-live="polite"><p v-if="!ready">{{ initializing ? '正在恢复创作草稿…' : '创作草稿尚未恢复' }}</p><button v-if="!ready && !initializing" class="btn btn-ghost btn-sm" type="button" @click="restore">重试恢复草稿</button><div v-if="draftRecoveryNeeded" class="qwen-draft-recovery"><p role="alert">旧草稿未能恢复：{{ draftRecoveryError }}</p><p>旧草稿仍保留；当前可继续创作。恢复槽只保留一份旧草稿，保存当前创作会替换更早的恢复副本。</p><div class="qwen-toolbar"><button class="btn btn-ghost btn-sm" type="button" :disabled="locked" @click="recoverDraft">重试恢复旧草稿</button><button class="btn btn-ghost btn-sm" type="button" :disabled="locked || restoredInputMissing" @click="saveRecoveredDraft">保留本次旧草稿，保存当前创作</button></div></div><p>{{ draftStatus }}</p><button v-if="draftFailed" class="btn btn-ghost btn-sm" type="button" @click="persistDraft">重试保存草稿</button><button v-if="restoredInputMissing && task" class="btn btn-ghost btn-sm" type="button" :disabled="importing || busy" @click="retrySourceInputs">重新读取原任务输入</button><p v-if="importing">正在读取输入图片…</p><p v-if="taskText">{{ taskText }}{{ progress === null || !unresolved ? '' : ` · ${progress}%` }}</p><p v-if="notice">{{ notice }}</p><p v-if="error" class="qwen-error" role="alert">{{ error }}</p><p v-if="!locked && issue">{{ issue }}</p></div>
        <div class="qwen-actions"><button v-if="task || request" class="btn btn-ghost" type="button" :disabled="observing || busy || importing || cancelling" @click="observe">查询原任务</button><button v-if="busy || unresolved" class="btn btn-ghost" type="button" :disabled="cancelling" @click="cancel">{{ cancelling ? '请求取消…' : '取消' }}</button><button class="btn btn-primary" type="submit" :disabled="!canRun"><ArchiveIcon name="spark" />{{ busy || unresolved ? '生成中…' : source ? '按指令编辑' : '生成图片' }}</button></div>
        <p class="qwen-hint">任务接收后可以离开页面；结果和取消状态以任务中心为准。</p>
      </form>
    </div>
  </article>
</template>
<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import ZoomableImageViewer from '@/components/visual/ZoomableImageViewer.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioCheckbox from '@/components/ui/StudioCheckbox.vue'
import { useQwenStudio } from '@/composables/generation/useQwenStudio'
import { useTaskCenter } from '@/composables/useTaskCenter'
const props = defineProps<{ mode?: 'qwen' | 'moss' }>()
const moss = props.mode === 'moss'
const title = moss ? 'MiaoMiao MOSS 创作' : 'Qwen 图像创作'
const introduction = moss ? '用中文、自然语言或标签描绘画面，也可以直接输入布局 JSON。' : '用文字生成画面，或结合原图与参考图，描述想做的修改。'
const { modelOptions, alignment, maxSize, form, randomSeed, resize, source, sourceUrl, references, needsResize, restoredInputMissing, selected, turbo, checking, statusError, task, request, result, resultUrl, resultBlob,
  busy, importing, observing, cancelling, saving, saved, error, notice, locked, unresolved, issue, canRun, progress, taskText,
  ready, initializing, draftRecoveryNeeded, draftRecoveryError, recoverDraft, preserveAndSaveDraft, draftStatus, draftFailed, persistDraft, parentId, continueResult, retryInputs, moveReference, refresh, loadSource, removeSource, addReferences, removeReference, run, cancel, observe, exportResult, initialize } = useQwenStudio(props.mode)
const route = useRoute(), router = useRouter(), picker = ref<HTMLInputElement | null>(null), preview = ref<'result' | 'source'>('result')
const referencePicker = ref<HTMLInputElement | null>(null), referenceButton = ref<HTMLButtonElement | null>(null), sourceButton = ref<HTMLButtonElement | null>(null), referencePreview = ref('')
const previewInputUrl = computed(() => references.value.find(value => value.id === referencePreview.value)?.url || sourceUrl.value)
const openTasks = () => useTaskCenter().openRuntimeTasks()
function retireReference(element: Element) { if (element instanceof HTMLElement) { element.inert = true; element.setAttribute('aria-hidden', 'true') } }
async function reorderReference(id: string, offset: -1 | 1, event: Event) {
  const button = event.currentTarget as HTMLButtonElement, focused = document.activeElement === button
  moveReference(id, offset); await nextTick()
  if (focused && button.disabled) button.closest('li')?.querySelector<HTMLButtonElement>('button')?.focus()
}
async function saveRecoveredDraft() { await preserveAndSaveDraft(); await consumeEntry() }
async function retrySourceInputs() { await retryInputs(); await consumeEntry() }
async function editResult() { await continueResult(); await consumeEntry(); await nextTick(); document.getElementById('qwen-prompt')?.focus() }
async function pick(event: Event) { const input = event.target as HTMLInputElement, file = input.files?.[0]; input.value = ''; if (file) { await loadSource(file); if (sourceUrl.value) { referencePreview.value = ''; preview.value = 'source'; await consumeEntry() } } }
async function pickReferences(event: Event) { const input = event.target as HTMLInputElement, files = Array.from(input.files ?? []); input.value = ''; await addReferences(files) }
async function dropReference(id: string) { removeReference(id); await nextTick(); referenceButton.value?.focus() }
async function clearSources() { removeSource(); await consumeEntry(); preview.value = 'result'; referencePreview.value = ''; await nextTick(); sourceButton.value?.focus() }
watch(resultUrl, value => { if (value) preview.value = 'result' })
watch(sourceUrl, value => { if (value) preview.value = 'source' })
watch(draftStatus, value => { if (value.startsWith('草稿已保存')) void consumeEntry() })
async function restore() {
  await initialize(typeof route.query.preparedModel === 'string' ? route.query.preparedModel : undefined,
    typeof route.query.job === 'string' ? route.query.job : undefined, typeof route.query.artwork === 'string' ? route.query.artwork : undefined)
  await consumeEntry()
}
let consumingEntry = false
async function consumeEntry() {
  if (consumingEntry || error.value || draftRecoveryNeeded.value || !ready.value || restoredInputMissing.value || !(route.query.job || route.query.artwork || route.query.preparedModel)) return
  consumingEntry = true
  try {
    if (!await persistDraft() || error.value) return
    const query = { ...route.query }; delete query.job; delete query.artwork; delete query.preparedModel
    await router.replace({ query })
  } finally { consumingEntry = false }
}
onMounted(restore)
</script>
<style scoped>
.qwen-studio { display:grid; align-content:start; gap:var(--s-6); width:100%; padding:var(--s-6); max-width:2200px; margin-inline:auto; }
.qwen-heading, .qwen-heading nav, .qwen-toolbar, .qwen-actions { display:flex; align-items:center; flex-wrap:wrap; gap:var(--s-3); }
.qwen-heading { justify-content:space-between; }
.qwen-heading h1 { margin:0; font-size:var(--fs-title); color:var(--text-primary); }
.qwen-studio p { margin:0; line-height:var(--lh-body); color:var(--text-secondary); overflow-wrap:anywhere; }
.qwen-heading p { margin-top:var(--s-2); }
.qwen-layout { display:grid; grid-template-columns:minmax(0,1fr) minmax(320px,400px); gap:var(--s-5); align-items:start; }
.qwen-canvas { display:grid; gap:var(--s-3); min-width:0; position:sticky; top:calc(var(--app-navigation-visible-height,80px) + var(--s-4)); }
.qwen-stage { display:grid; grid-template:minmax(0,1fr)/minmax(0,1fr); height:clamp(360px,68vh,1100px); overflow:hidden; background:var(--art-stage); border:1px solid var(--border-soft); border-radius:var(--r-lg); }
.qwen-stage > * { grid-area:1/1; min-width:0; min-height:0; }
.qwen-empty { display:grid; place-content:center; justify-items:center; gap:var(--s-3); padding:var(--s-6); text-align:center; background:var(--bg-surface); }
.qwen-empty > .archive-icon { width:48px; height:48px; color:var(--text-secondary); }
.qwen-empty h2 { margin:0; font-size:var(--fs-title-sm); color:var(--text-primary); }
.qwen-controls { display:grid; gap:var(--s-4); padding:var(--s-5); background:var(--bg-surface); border:1px solid var(--border-soft); border-radius:var(--r-lg); }
.qwen-readiness, .qwen-source, .qwen-feedback { display:grid; gap:var(--s-2); }
.qwen-references { list-style:none; margin:0; padding:0; display:grid; gap:var(--s-2); }
.qwen-references li { display:flex; align-items:center; justify-content:space-between; gap:var(--s-2); min-width:0; }
.qwen-references li > button:first-child { min-width:0; white-space:normal; overflow-wrap:anywhere; text-align:start; }
.qwen-readiness { padding-bottom:var(--s-3); border-bottom:1px solid var(--border-soft); }
.qwen-readiness .qwen-toolbar { justify-content:space-between; }
.qwen-field { display:grid; gap:var(--s-2); min-width:0; }
.qwen-field label { color:var(--text-primary); font-size:var(--fs-label); }
.qwen-pair { display:grid; grid-template-columns:1fr 1fr; gap:var(--s-3); }
.qwen-hint, .qwen-readiness p, .qwen-source p { font-size:var(--fs-label-sm); }
.qwen-studio .qwen-error { color:var(--danger-text); }
.qwen-actions { justify-content:flex-end; }
.qwen-advanced-body { display:grid; gap:var(--s-4); padding-top:var(--s-3); }
.qwen-reference-actions { display:flex; flex-wrap:wrap; gap:var(--s-1); }
.qwen-reference-move, .qwen-reference-enter-active, .qwen-reference-leave-active { transition:transform var(--spring-gentle-duration) var(--spring-gentle-ease), opacity var(--spring-gentle-duration) var(--spring-gentle-ease); }
.qwen-reference-enter-from, .qwen-reference-leave-to { opacity:0; transform:translateY(var(--s-2)); }
@media (prefers-reduced-motion:reduce) { :root:not([data-motion='full']) .qwen-references > li { transition:none; } }
:root:is([data-motion='reduce'],[data-motion='reduced'],[data-reduced-motion='true']) .qwen-references > li { transition:none; }
/* Below 980px the 320px control rail crowds the complete-image canvas. */
@media (max-width:980px) { .qwen-layout { grid-template-columns:minmax(0,1fr); } .qwen-canvas { position:static; } .qwen-stage { height:clamp(320px,55vh,720px); } }

</style>
