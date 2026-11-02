<script setup lang="ts">
import { computed } from 'vue'
import GenerationSizePicker from './GenerationSizePicker.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioCheckbox from '@/components/ui/StudioCheckbox.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import type { NativeDrawing } from '@/composables/prompt/useNativeDrawing'
import { useDrawingNavigation } from '@/composables/prompt/useDrawingNavigation'
import { useRoute, useRouter } from 'vue-router'
const props = defineProps<{ drawing: NativeDrawing; busy: boolean }>()
const state = computed(() => props.drawing.session.value)
const navigation = useDrawingNavigation(), route = useRoute(), router = useRouter()
function editOriginal() {
  if (state.value?.task.value) void router.push({ path: '/prompt-builder', query: { ...route.query, editor: 'qwen', job: state.value.task.value.taskId } })
  else void navigation.editImage(state.value?.sourceUrl.value || '')
}
</script>

<template>
  <div class="native-drawing-controls">
    <template v-if="state">
      <div class="native-field"><label for="native-drawing-model">基础模型</label><StudioSelect id="native-drawing-model" v-model="state.form.modelId" label="基础模型" size="sm" :options="state.modelOptions" :disabled="drawing.locked.value" /></div>
      <section class="native-readiness" aria-label="模型准备状态"><p>{{ state.statusError.value || state.selected.value?.unavailableReason || '基于角色、场景及画面描述生成。' }}</p><div class="native-buttons"><button class="btn btn-quiet btn-sm" type="button" :disabled="state.checking.value || busy" @click="state.refresh()">重新检查</button><RouterLink v-if="!state.selected.value?.available" class="btn btn-ghost btn-sm" :to="{ path: '/control', query: { engine: 'native', model: state.form.modelId } }">准备模型</RouterLink></div></section>
      <GenerationSizePicker :engine="drawing.mode.value || ''" :size="drawing.size.value" :anima-sizes="drawing.sizes.value" :busy="drawing.locked.value" @update:size="drawing.setSize" />
      <slot v-if="drawing.mode.value === 'moss'" name="style" />
      <section v-if="drawing.mode.value === 'moss' && state.result.value" class="native-readiness" aria-label="Remacri 结果放大">
        <p>Remacri · 结果放大</p>
        <div class="native-buttons">
          <button class="btn btn-quiet btn-sm" type="button" :disabled="!state.canUpscale.value" @click="state.upscaleResult(1.5)">1.5× 放大</button>
          <button class="btn btn-quiet btn-sm" type="button" :disabled="!state.canUpscale.value" @click="state.upscaleResult(2)">2× 放大</button>
          <button v-if="typeof state.result.value.input.mossUpscaleSourceTaskId === 'string'" class="btn btn-ghost btn-sm" type="button" :disabled="drawing.locked.value" @click="router.push({ path: '/prompt-builder', query: { ...route.query, job: state.result.value.input.mossUpscaleSourceTaskId } })">查看原图</button>
        </div>
        <p>{{ state.result.value.input.mossUpscaleScale ? '当前为放大副本；可查看原图选择另一倍率。' : !state.selected.value?.mossRemacri ? '请先在模型目录准备 Remacri 超分权重。' : '生成更清晰的大图副本，保留原图，不重新绘制。' }}</p>
      </section>
      <div v-if="state.source.value || state.restoredInputMissing.value" class="native-buttons"><button class="btn btn-ghost btn-sm" type="button" :disabled="busy" @click="editOriginal">继续编辑原图</button><button class="btn btn-quiet btn-sm" type="button" :disabled="drawing.locked.value" @click="state.removeSource()">转为文生图</button></div>
      <details class="inspector-route"><StudioDisclosureSummary>高级调整 · {{ state.turbo.value ? '8' : state.form.steps }} 步 · {{ state.randomSeed.value ? '随机种子' : '固定种子' }}</StudioDisclosureSummary><div class="native-advanced">
        <div class="native-pair"><div class="native-field"><label for="native-width">宽度（px）</label><input id="native-width" v-model.number="state.form.width" class="input" type="number" min="512" :max="state.maxSize" :step="state.alignment" :disabled="drawing.locked.value" aria-describedby="native-size-help" /></div><div class="native-field"><label for="native-height">高度（px）</label><input id="native-height" v-model.number="state.form.height" class="input" type="number" min="512" :max="state.maxSize" :step="state.alignment" :disabled="drawing.locked.value" aria-describedby="native-size-help" /></div></div>
        <p id="native-size-help">每边 512–{{ state.maxSize }} px，为 {{ state.alignment }} 的倍数。</p>
        <template v-if="!state.turbo.value">
          <div class="native-field"><label for="native-negative">模型负向描述</label><textarea id="native-negative" v-model="state.form.negative" class="textarea" rows="3" maxlength="8000" :disabled="drawing.locked.value" spellcheck="false" autocorrect="off" autocapitalize="off" /></div>
          <div class="native-pair"><div class="native-field"><label for="native-steps">步数</label><input id="native-steps" v-model.number="state.form.steps" class="input" type="number" min="1" max="100" :disabled="drawing.locked.value" /></div><div class="native-field"><label for="native-cfg">CFG</label><input id="native-cfg" v-model.number="state.form.cfg" class="input" type="number" :min="drawing.mode.value === 'moss' ? 0 : 1.1" max="20" step="0.1" :disabled="drawing.locked.value" /></div></div>
          <div v-if="drawing.mode.value === 'moss'" class="native-field"><label for="native-cache">缓存加速</label><StudioSelect id="native-cache" v-model="state.form.mossAcceleration" label="缓存加速" :disabled="drawing.locked.value" :options="[{value:'off',label:'关闭 · 完整计算'},{value:'spectrum',label:'Spectrum · 实验',disabled:!state.selected.value?.mossSpectrum}]" /></div>
          <p v-if="drawing.mode.value === 'moss'">新创作默认开启 Spectrum，可关闭使用完整计算。预测会占用额外显存，并可能改变局部细节。</p>
          <template v-if="drawing.mode.value === 'moss' && state.form.mossAcceleration === 'spectrum'">
            <div class="native-field"><label for="native-spectrum-flex">Spectrum 加速强度</label><input id="native-spectrum-flex" v-model.number="state.form.mossSpectrumFlexWindow" class="input" type="number" min="0" max="2" step="0.05" :disabled="drawing.locked.value || !state.selected.value?.mossFlexWindow" aria-describedby="native-spectrum-flex-help" /></div>
            <p id="native-spectrum-flex-help">默认 0.5；0.25 更保守，1 更激进。越大预测越多，细节变化也可能更明显。0 仍会预测；关闭请选完整计算。</p>
          </template>
          <template v-if="drawing.mode.value === 'moss'">
            <div class="native-field"><label for="native-weight-precision">主模型权重</label><StudioSelect id="native-weight-precision" v-model="state.form.mossWeightPrecision" label="主模型权重" :disabled="drawing.locked.value" aria-describedby="native-weight-help" :options="[{value:'auto',label:state.selected.value?.mossInt8Ready?'自动 · 作者 INT8':'自动 · 作者 FP16'},{value:'fp16',label:'作者 FP16',disabled:!state.selected.value?.mossFp16Ready},{value:'int8',label:'作者 INT8 · 省显存',disabled:!state.selected.value?.mossInt8Ready}]" /></div>
            <p id="native-weight-help">{{ state.selected.value?.mossInt8Ready ? '作者 INT8 已导入，自动模式优先使用。文本编码精度单独选择；切换主模型权重会重新准备。' : '尚未导入作者 INT8，自动模式使用 FP16。' }}</p>
            <div class="native-field"><label for="native-text-precision">文本编码精度</label><StudioSelect id="native-text-precision" v-model="state.form.mossTextPrecision" label="文本编码精度" :disabled="drawing.locked.value" aria-describedby="native-precision-help" :options="[{value:'bf16',label:'原始精度'},{value:'fp8',label:'FP8 · 省显存（实验）',disabled:!state.selected.value?.mossFp8},{value:'int8',label:'INT8 · 加速与省显存',disabled:!state.selected.value?.mossTextInt8Ready}]" /></div>
            <p id="native-precision-help">INT8 使用独立量化的文本编码器；FP8 减少权重显存。两者都可能改变画面细节，切换后会重新准备模型。</p>
            <StudioCheckbox v-model:checked="state.form.mossCompile" label="编译推理内核" :disabled="drawing.locked.value || !state.selected.value?.mossCompile && !state.form.mossCompile" aria-describedby="native-compile-help">编译推理内核</StudioCheckbox>
            <p id="native-compile-help">默认关闭，可直接开始生成。开启后首次编译主模型较慢；后续复用，遇到需要重编译的输入使用普通执行。</p>
          </template>
        </template>
        <p v-else>Turbo 固定 8 步、CFG 1，不使用负向描述。</p>
        <StudioCheckbox v-model:checked="state.randomSeed.value" label="每次随机种子" :disabled="drawing.locked.value">每次随机种子</StudioCheckbox>
        <div v-if="!state.randomSeed.value" class="native-field"><label for="native-seed">种子</label><input id="native-seed" v-model.number="state.form.seed" class="input" type="number" min="0" max="2147483647" step="1" :disabled="drawing.locked.value" spellcheck="false" autocorrect="off" /></div>
      </div></details>
      <div class="native-feedback" aria-live="polite"><p v-if="!state.ready.value">{{ state.initializing.value ? '参数恢复中…' : state.error.value }}</p><button v-if="!state.ready.value && !state.initializing.value" class="btn btn-ghost btn-sm" type="button" @click="drawing.initialize()">恢复参数</button><template v-if="state.draftRecoveryNeeded.value"><p role="alert">{{ state.draftRecoveryError.value }}</p><button class="btn btn-ghost btn-sm" type="button" :disabled="drawing.locked.value" @click="state.recoverDraft()">重试恢复</button><button class="btn btn-ghost btn-sm" type="button" :disabled="drawing.locked.value" @click="state.preserveAndSaveDraft()">保存当前参数</button></template><p v-if="state.notice.value">{{ state.notice.value }}</p><p v-if="state.draftFailed.value" role="alert">{{ state.draftStatus.value }}</p><button v-if="state.draftFailed.value" class="btn btn-ghost btn-sm" type="button" @click="state.persistDraft()">重试保存</button></div>
    </template>
  </div>
</template>

<style scoped>
.native-drawing-controls,.native-field,.native-advanced,.native-feedback { display:grid; gap:var(--s-3); min-width:0; }
.native-field { gap:var(--s-2); }
.native-field label { font-size:var(--fs-label); color:var(--text-primary); }
.native-readiness { padding-block:var(--s-3); border-block:1px solid var(--border-soft); }
.native-drawing-controls p { margin:0; color:var(--text-secondary); font-size:var(--fs-label); line-height:var(--lh-body); overflow-wrap:anywhere; }
.native-buttons { display:flex; flex-wrap:wrap; gap:var(--s-2); margin-top:var(--s-2); }
.native-pair { display:grid; grid-template-columns:1fr 1fr; gap:var(--s-3); }
.native-advanced { padding-top:var(--s-3); }
</style>
