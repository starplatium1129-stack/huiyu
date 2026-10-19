<template>
  <article class="qwen-studio">
    <header class="qwen-heading">
      <div><h1>Qwen 图像创作</h1><p>用文字生成画面，或结合原图与参考图，描述想做的修改。</p></div>
      <nav aria-label="图像创作导航"><RouterLink class="btn btn-ghost" to="/prompt-builder">绘图画室</RouterLink><RouterLink class="btn btn-ghost" to="/gallery">我的作品</RouterLink><button class="btn btn-ghost" type="button" @click="openTasks">任务中心</button></nav>
    </header>
    <div class="qwen-layout">
      <section class="qwen-canvas" aria-label="图像预览">
        <div class="qwen-toolbar"><div class="studio-segments" role="group" aria-label="预览图片">
          <button type="button" :class="{ active: preview === 'result' }" :aria-pressed="preview === 'result'" @click="preview = 'result'">生成结果</button>
          <button type="button" :class="{ active: preview === 'source' }" :aria-pressed="preview === 'source'" :disabled="!sourceUrl" @click="referencePreview = ''; preview = 'source'">输入图片</button>
        </div><span v-if="result && preview === 'result'">{{ result.input.width }} × {{ result.input.height }}</span></div>
        <div class="qwen-stage">
          <ZoomableImageViewer v-if="preview === 'source' ? previewInputUrl : resultUrl" :src="preview === 'source' ? previewInputUrl : resultUrl" :alt="preview === 'source' ? '编辑输入图片' : 'Qwen 生成结果'" />
          <div v-else class="qwen-empty"><ArchiveIcon name="image" /><h2>{{ result ? '结果已保存在任务中' : '从一句描述开始' }}</h2><p>{{ result ? '可直接入册，或重新读取预览。' : '填写画面描述，再点击生成。编辑已有图片时，先导入原图。' }}</p></div>
        </div>
        <p v-if="result && task?.taskId !== result.taskId">这里保留的是上一次结果，新任务不会覆盖已保存的图片。</p>
        <div class="qwen-toolbar"><button class="btn btn-ghost" type="button" :disabled="!result || saving || busy || importing || saved" @click="exportResult('save')"><ArchiveIcon name="gallery" />{{ saved ? '已存入我的作品' : '存入我的作品' }}</button><button class="btn btn-ghost" type="button" :disabled="!resultBlob || saving || busy || importing" @click="exportResult('download')"><ArchiveIcon name="download" />导出 PNG</button></div>
      </section>
      <form class="qwen-controls" @submit.prevent="run">
        <section class="qwen-readiness" aria-label="模型准备状态">
          <div class="qwen-toolbar"><strong>{{ selected?.available ? '模型文件已就绪' : '准备 Qwen 模型' }}</strong><button class="btn btn-quiet btn-sm" type="button" :disabled="checking || busy" @click="refresh">{{ checking ? '检查中…' : '重新检查' }}</button></div>
          <p>{{ statusError || selected?.unavailableReason || '填写画面描述即可开始，也可以导入原图及最多三张参考图进行编辑。' }}</p>
          <RouterLink v-if="!selected?.available" class="btn btn-ghost btn-sm" :to="{ path: '/control', query: { engine: 'native', model: form.modelId } }">前往控制室准备</RouterLink>
        </section>
        <div class="qwen-field"><label for="qwen-model">模型</label><StudioSelect id="qwen-model" v-model="form.modelId" label="Qwen 模型" :options="qwenModels" :disabled="locked" /></div>
        <div class="qwen-field"><label for="qwen-prompt">{{ source ? '编辑指令' : '画面描述' }}</label><textarea id="qwen-prompt" v-model="form.prompt" rows="5" maxlength="12000" :disabled="locked" :placeholder="source ? '描述要改变的部分，以及需要保留的内容' : '描述主体、构图、环境与光线'" /></div>
        <section class="qwen-source" aria-label="可选编辑原图">
          <div class="qwen-toolbar"><button ref="sourceButton" class="btn btn-ghost btn-sm" type="button" :disabled="locked" @click="picker?.click()"><ArchiveIcon name="upload" />{{ source ? '更换原图' : '导入编辑原图' }}</button><button v-if="source || restoredInputMissing" class="btn btn-quiet btn-sm" type="button" :disabled="locked" @click="clearSources">移除输入，改为文生图</button></div>
          <input ref="picker" type="file" hidden accept="image/png,image/jpeg,image/webp" @change="pick" />
          <p v-if="source">图 1 · {{ source.name }} · {{ source.width }} × {{ source.height }}</p><p v-else>可选 · PNG、JPEG、WebP · 每张最大 16 MB</p>
          <template v-if="source">
            <button ref="referenceButton" class="btn btn-ghost btn-sm" type="button" :disabled="locked || references.length >= 3" @click="referencePicker?.click()"><ArchiveIcon name="upload" />添加参考图（{{ references.length }} / 3）</button>
            <input ref="referencePicker" type="file" hidden multiple accept="image/png,image/jpeg,image/webp" @change="pickReferences" />
            <ol v-if="references.length" class="qwen-references" aria-label="参考图顺序" start="2">
              <li v-for="(value, index) in references" :key="value.id"><button class="btn btn-quiet btn-sm" type="button" :aria-label="`预览图 ${index + 2}：${value.image.name}`" @click="referencePreview = value.id; preview = 'source'">图 {{ index + 2 }} · {{ value.image.name }}</button><button class="btn btn-quiet btn-sm" type="button" :disabled="locked" :aria-label="`移除图 ${index + 2}：${value.image.name}`" @click="dropReference(value.id)">移除</button></li>
            </ol>
            <p>按显示顺序提供图片；可在指令中用「图 1」「图 2」指定用途。</p>
          </template>
          <StudioCheckbox v-if="needsResize" v-model:checked="resize" :disabled="locked" label="缩小超限输入图片副本">按处理上限缩小超限图片的副本，保留本地原文件</StudioCheckbox>
        </section>
        <div class="qwen-pair"><div class="qwen-field"><label for="qwen-width">宽度</label><input id="qwen-width" v-model.number="form.width" type="number" min="512" max="2816" step="32" :disabled="locked" /></div><div class="qwen-field"><label for="qwen-height">高度</label><input id="qwen-height" v-model.number="form.height" type="number" min="512" max="2816" step="32" :disabled="locked" /></div></div>
        <p class="qwen-hint">宽高为 32 的倍数。大画幅会增加显存与内存占用。</p>
        <template v-if="!turbo">
          <div class="qwen-field"><label for="qwen-negative">负向描述（可选）</label><textarea id="qwen-negative" v-model="form.negative" rows="2" maxlength="8000" :disabled="locked" /></div>
          <div class="qwen-pair"><div class="qwen-field"><label for="qwen-steps">步数</label><input id="qwen-steps" v-model.number="form.steps" type="number" min="1" max="100" :disabled="locked" /></div><div v-if="form.negative.trim()" class="qwen-field"><label for="qwen-cfg">CFG</label><input id="qwen-cfg" v-model.number="form.cfg" type="number" min="1.1" max="20" step="0.1" :disabled="locked" /></div></div>
        </template>
        <p v-else class="qwen-hint">Turbo 使用固定 8 步、CFG 1，无负向描述。</p>
        <StudioCheckbox v-model:checked="randomSeed" :disabled="locked" label="每次随机种子">每次随机种子</StudioCheckbox>
        <div v-if="!randomSeed" class="qwen-field"><label for="qwen-seed">种子</label><input id="qwen-seed" v-model.number="form.seed" type="number" min="0" max="2147483647" step="1" :disabled="locked" /></div>
        <p v-if="selected" class="qwen-hint">Qwen 权重使用研究许可，商用须另获授权。<a :href="selected.licenseUrl" target="_blank" rel="noopener noreferrer">查看许可</a></p>
        <div class="qwen-feedback" aria-live="polite"><p v-if="importing">正在读取输入图片…</p><p v-if="taskText">{{ taskText }}{{ progress === null || !unresolved ? '' : ` · ${progress}%` }}</p><p v-if="notice">{{ notice }}</p><p v-if="error" class="qwen-error" role="alert">{{ error }}</p><p v-if="!locked && issue">{{ issue }}</p></div>
        <div class="qwen-actions"><button v-if="task || request" class="btn btn-ghost" type="button" :disabled="observing || busy || importing || cancelling" @click="observe">查询原任务</button><button v-if="busy || unresolved" class="btn btn-ghost" type="button" :disabled="cancelling" @click="cancel">{{ cancelling ? '请求取消…' : '取消' }}</button><button class="btn btn-primary" type="submit" :disabled="!canRun"><ArchiveIcon name="spark" />{{ busy || unresolved ? '生成中…' : source ? '按指令编辑' : '生成图片' }}</button></div>
        <p class="qwen-hint">任务接收后可以离开页面；结果和取消状态以任务中心为准。</p>
      </form>
    </div>
  </article>
</template>
<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, RouterLink } from 'vue-router'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import ZoomableImageViewer from '@/components/visual/ZoomableImageViewer.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioCheckbox from '@/components/ui/StudioCheckbox.vue'
import { qwenModels } from '@/api/qwenApi'
import { useQwenStudio } from '@/composables/generation/useQwenStudio'
import { useTaskCenter } from '@/composables/useTaskCenter'
const { form, randomSeed, resize, source, sourceUrl, references, needsResize, restoredInputMissing, selected, turbo, checking, statusError, task, request, result, resultUrl, resultBlob,
  busy, importing, observing, cancelling, saving, saved, error, notice, locked, unresolved, issue, canRun, progress, taskText,
  refresh, loadSource, removeSource, addReferences, removeReference, run, cancel, observe, exportResult, initialize } = useQwenStudio()
const route = useRoute(), picker = ref<HTMLInputElement | null>(null), preview = ref<'result' | 'source'>('result')
const referencePicker = ref<HTMLInputElement | null>(null), referenceButton = ref<HTMLButtonElement | null>(null), sourceButton = ref<HTMLButtonElement | null>(null), referencePreview = ref('')
const previewInputUrl = computed(() => references.value.find(value => value.id === referencePreview.value)?.url || sourceUrl.value)
const openTasks = () => useTaskCenter().openRuntimeTasks()
async function pick(event: Event) { const input = event.target as HTMLInputElement, file = input.files?.[0]; input.value = ''; if (file) { await loadSource(file); if (sourceUrl.value) { referencePreview.value = ''; preview.value = 'source' } } }
async function pickReferences(event: Event) { const input = event.target as HTMLInputElement, files = Array.from(input.files ?? []); input.value = ''; await addReferences(files) }
async function dropReference(id: string) { removeReference(id); await nextTick(); referenceButton.value?.focus() }
async function clearSources() { removeSource(); preview.value = 'result'; referencePreview.value = ''; await nextTick(); sourceButton.value?.focus() }
watch(resultUrl, value => { if (value) preview.value = 'result' })
watch(sourceUrl, value => { if (value) preview.value = 'source' })
onMounted(() => initialize(typeof route.query.preparedModel === 'string' ? route.query.preparedModel : undefined,
  typeof route.query.job === 'string' ? route.query.job : undefined, typeof route.query.artwork === 'string' ? route.query.artwork : undefined))
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
.qwen-empty { display:grid; place-content:center; justify-items:center; gap:var(--s-3); padding:var(--s-6); text-align:center; background:var(--bg-elevated); }
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
.qwen-field input, .qwen-field textarea { width:100%; min-width:0; padding:var(--s-3); color:var(--text-primary); background:var(--bg-elevated); border:1px solid var(--border-soft); border-radius:var(--r-md); font:inherit; }
.qwen-field textarea { resize:vertical; }
.qwen-field input:focus-visible, .qwen-field textarea:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
.qwen-field input:disabled, .qwen-field textarea:disabled { color:var(--text-disabled); }
.qwen-field textarea::placeholder { color:var(--text-secondary); }
.qwen-pair { display:grid; grid-template-columns:1fr 1fr; gap:var(--s-3); }
.qwen-hint, .qwen-readiness p, .qwen-source p { font-size:var(--fs-label-sm); }
.qwen-studio .qwen-error { color:var(--danger-text); }
.qwen-actions { justify-content:flex-end; }
@media (max-width:980px) { .qwen-layout { grid-template-columns:minmax(0,1fr); } .qwen-canvas { position:static; } .qwen-stage { height:clamp(320px,55vh,720px); } }
@media (forced-colors:active) { .qwen-field input:focus-visible, .qwen-field textarea:focus-visible { outline:2px solid Highlight; } }
</style>
