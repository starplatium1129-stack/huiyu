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
      <section class="native-readiness" aria-label="模型准备状态"><p>{{ state.statusError.value || state.selected.value?.unavailableReason || '使用左侧角色、场景和画面描述生成，不加载 Anima 角色 LoRA。' }}</p><div class="native-buttons"><button class="btn btn-quiet btn-sm" type="button" :disabled="state.checking.value || busy" @click="state.refresh()">重新检查</button><RouterLink v-if="!state.selected.value?.available" class="btn btn-ghost btn-sm" :to="{ path: '/control', query: { engine: 'native', model: state.form.modelId } }">准备模型</RouterLink></div></section>
      <GenerationSizePicker :engine="drawing.mode.value || ''" :size="drawing.size.value" :anima-sizes="drawing.sizes.value" :busy="drawing.locked.value" @update:size="drawing.setSize" />
      <div v-if="state.source.value || state.restoredInputMissing.value" class="native-buttons"><button class="btn btn-ghost btn-sm" type="button" :disabled="busy" @click="editOriginal">在 Qwen 窗口继续编辑原图</button><button class="btn btn-quiet btn-sm" type="button" :disabled="drawing.locked.value" @click="state.removeSource()">移除编辑输入，改用文生图</button></div>
      <details class="inspector-route"><StudioDisclosureSummary>高级调整 · {{ state.turbo.value ? '8' : state.form.steps }} 步 · {{ state.randomSeed.value ? '随机种子' : '固定种子' }}</StudioDisclosureSummary><div class="native-advanced">
        <div class="native-pair"><div class="native-field"><label for="native-width">宽度（px）</label><input id="native-width" v-model.number="state.form.width" class="input" type="number" min="512" :max="state.maxSize" :step="state.alignment" :disabled="drawing.locked.value" aria-describedby="native-size-help" /></div><div class="native-field"><label for="native-height">高度（px）</label><input id="native-height" v-model.number="state.form.height" class="input" type="number" min="512" :max="state.maxSize" :step="state.alignment" :disabled="drawing.locked.value" aria-describedby="native-size-help" /></div></div>
        <p id="native-size-help">每边 512–{{ state.maxSize }} px，为 {{ state.alignment }} 的倍数。</p>
        <template v-if="!state.turbo.value">
          <div class="native-field"><label for="native-negative">模型负向描述</label><textarea id="native-negative" v-model="state.form.negative" class="textarea" rows="3" maxlength="8000" :disabled="drawing.locked.value" spellcheck="false" autocorrect="off" autocapitalize="off" /></div>
          <div class="native-pair"><div class="native-field"><label for="native-steps">步数</label><input id="native-steps" v-model.number="state.form.steps" class="input" type="number" min="1" max="100" :disabled="drawing.locked.value" /></div><div class="native-field"><label for="native-cfg">CFG</label><input id="native-cfg" v-model.number="state.form.cfg" class="input" type="number" :min="drawing.mode.value === 'moss' ? 0 : 1.1" max="20" step="0.1" :disabled="drawing.locked.value" /></div></div>
          <div v-if="drawing.mode.value === 'moss'" class="native-field"><label for="native-cache">缓存加速</label><StudioSelect id="native-cache" v-model="state.form.mossAcceleration" label="缓存加速" :disabled="drawing.locked.value" :options="[{value:'off',label:'关闭 · 完整计算'},{value:'spectrum',label:'Spectrum · 实验',disabled:!state.selected.value?.mossSpectrum}]" /></div>
          <p v-if="drawing.mode.value === 'moss'">Spectrum 为实验加速，可能改变细节并额外占用显存，尚待实机验证。</p>
        </template>
        <p v-else>Turbo 固定 8 步、CFG 1，不使用负向描述。</p>
        <StudioCheckbox v-model:checked="state.randomSeed.value" label="每次随机种子" :disabled="drawing.locked.value">每次随机种子</StudioCheckbox>
        <div v-if="!state.randomSeed.value" class="native-field"><label for="native-seed">种子</label><input id="native-seed" v-model.number="state.form.seed" class="input" type="number" min="0" max="2147483647" step="1" :disabled="drawing.locked.value" spellcheck="false" autocorrect="off" /></div>
      </div></details>
      <div class="native-feedback" aria-live="polite"><p v-if="!state.ready.value">{{ state.initializing.value ? '正在恢复绘图参数…' : state.error.value }}</p><button v-if="!state.ready.value && !state.initializing.value" class="btn btn-ghost btn-sm" type="button" @click="drawing.initialize()">重新恢复参数</button><template v-if="state.draftRecoveryNeeded.value"><p role="alert">{{ state.draftRecoveryError.value }}</p><button class="btn btn-ghost btn-sm" type="button" :disabled="drawing.locked.value" @click="state.recoverDraft()">重试恢复草稿</button><button class="btn btn-ghost btn-sm" type="button" :disabled="drawing.locked.value" @click="state.preserveAndSaveDraft()">保留旧草稿，保存当前参数</button></template><p v-if="state.notice.value">{{ state.notice.value }}</p><p v-if="state.draftFailed.value" role="alert">{{ state.draftStatus.value }}</p><button v-if="state.draftFailed.value" class="btn btn-ghost btn-sm" type="button" @click="state.persistDraft()">重试保存参数</button></div>
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
