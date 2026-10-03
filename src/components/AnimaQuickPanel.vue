<script setup lang="ts">
import { computed, useId } from 'vue'
import type { AnimaGenerationState } from '@/types/anima'
import { resolveDrawCapabilities } from '@/utils/drawCapabilities'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import ToggleSwitch from '@/components/visual/ToggleSwitch.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'

const props = defineProps<{
  state: AnimaGenerationState
  /** 热门角色无 LoRA 模式（由父级按 subject + capability 判定，面板不做模型 id 猜测）。 */
  noLora?: boolean
}>()
const state = computed(() => props.state)
const emit = defineEmits<{
  (event: 'update:state', patch: Partial<AnimaGenerationState>): void
  /** 失败后按当前面板配置重发一次（2026-08-30 UX 审计：Comfy 侧的恢复动作）。 */
  (event: 'retry'): void
}>()

function patch(patch: Partial<AnimaGenerationState>) { emit('update:state', patch) }

/**
 * 表单控件与标签的关联 id（2026-08-30 UX 审计 P1）。
 *
 * 此前 LoRA/Seed/Steps/CFG/尺寸的说明文字是裸 <span>，读屏只会播「编辑框
 * 数字」，不知道这一格是什么。改用 useId 而非硬编码：本面板可能同时存在多个
 * 实例，硬编码 id 会产生重复 id，读屏与点击标签都会指错控件。
 */
const uid = useId()
function idOf(field: string) { return `${uid}-${field}` }

const loraId = computed({ get: () => props.state.loraId, set: value => patch({ loraId: value }) })
const loraStrength = computed({ get: () => props.state.loraStrength, set: value => patch({ loraStrength: value }) })
const seed = computed({ get: () => props.state.seed ?? '', set: value => patch({ seed: value === '' ? null : Number(value) }) })
const steps = computed({ get: () => props.state.steps, set: value => patch({ steps: value }) })
const cfg = computed({ get: () => props.state.cfg, set: value => patch({ cfg: value }) })
const teaCache = computed({ get: () => props.state.teaCache !== false, set: value => patch({ teaCache: value }) })
const hiresFix = computed({ get: () => Boolean(props.state.hiresFix), set: value => patch({ hiresFix: value }) })
const hiresScale = computed({ get: () => props.state.hiresScale || 2.0, set: value => patch({ hiresScale: value }) })
const hiresDenoise = computed({ get: () => props.state.hiresDenoise || 0.35, set: value => patch({ hiresDenoise: value }) })
const size = computed({
  get: () => `${props.state.width}x${props.state.height}`,
  set: value => {
    const [width, height] = value.split('x').map(Number)
    if (Number.isInteger(width) && Number.isInteger(height)) patch({ width, height })
  },
})

const busy = computed(() => ['submitting', 'running', 'cancelling'].includes(props.state.phase))
const progressStyle = computed(() => ({ '--progress': Math.max(0, Math.min(1, props.state.progress ?? 0)) }))
const outputSize = computed(() => {
  const scale = props.state.hiresFix ? (props.state.hiresScale ?? 2) : 1
  return `${Math.round(props.state.width * scale / 8) * 8} × ${Math.round(props.state.height * scale / 8) * 8}`
})
const selectedModel = computed(() => props.state.models.find(model => model.id === props.state.modelId) ?? null)
const selectedLora = computed(() => props.state.loras.find(lora => lora.id === props.state.loraId) ?? null)
/** 当前底模能力表：引擎默认值 + 后端模型能力合并（UI 不再按 family 散落判断）。 */
const capabilities = computed(() => resolveDrawCapabilities(props.state.family, null, selectedModel.value?.capabilities ?? null))
/** 热门角色无 LoRA：只在 popular subject + noLora capability 时隐藏 LoRA 选择。 */
const noLoraMode = computed(() => props.noLora === true && selectedModel.value?.capabilities?.noLora === true)
const availableSizes = computed(() => selectedModel.value?.sizes?.length ? selectedModel.value.sizes : ['832x1216', '1024x1024', '1216x832'])
function randomSeed() { patch({ seed: Math.floor(Math.random() * 1_000_000_000) }) }
</script>

<template>
  <details class="panel step-panel anima-quick-panel">
    <summary class="panel-title">
       <span>{{ state.family === 'krea2' ? 'Krea 2 · Comfy 创作引擎' : 'Anima · 生成参数' }}</span>
      <span class="anima-status" :class="state.online ? 'is-on' : 'is-off'">{{ state.online ? '● 在线' : '○ 离线' }}</span>
    </summary>
    <div class="anima-body tw:flex tw:flex-col tw:gap-[8px]">
       <p class="anima-hint tw:text-label-xs tw:text-secondary tw:m-0">{{ state.checkMsg }}</p>
       <p v-if="capabilities.promptFormat === 'natural-language'" class="anima-preview-note tw:m-0 tw:text-warning-text tw:text-label-xs tw:leading-label"><strong>Krea 2 实验</strong> · 纯自然语言、无角色 LoRA，身份还原需以实际出图为准。</p>
        <p v-else-if="noLoraMode" class="anima-preview-note tw:m-0 tw:text-warning-text tw:text-label-xs tw:leading-label"><strong>无需 LoRA</strong> · 通用底模直出，不加载角色 LoRA，身份由词条锚定</p>
        <p v-else-if="selectedLora?.preview" class="anima-preview-note tw:m-0 tw:text-warning-text tw:text-label-xs tw:leading-label"><strong>实验预览</strong> · 此 LoRA 为实验版</p>

       <div v-if="capabilities.lora && !noLoraMode" class="anima-row">
        <label :for="idOf('lora')">LoRA</label>
        <StudioSelect :id="idOf('lora')" v-model="loraId" label="LoRA" :disabled="busy"
          :options="state.loras.map(l => ({ value: l.id, label: l.name || l.id }))" />
        <label :for="idOf('strength')" class="anima-inline tw:text-label-xs tw:text-secondary">强度</label>
        <input :id="idOf('strength')" v-model.number="loraStrength" type="number" min="0.65" max="1" step="0.05" class="anima-num" :disabled="busy" />
       </div>
      <div class="anima-parameter-grid tw:grid tw:gap-s-2">
        <div class="anima-field anima-seed-field">
          <label :for="idOf('seed')">随机种子</label>
          <div class="anima-seed-control tw:flex tw:gap-[6px] tw:min-w-0">
            <input :id="idOf('seed')" v-model.number="seed" type="number" min="0" step="1" class="anima-num anima-seed" :disabled="busy" />
            <button type="button" class="anima-btn tw:rounded-sm tw:text-label-xs tw:cursor-pointer" :disabled="busy" @click="randomSeed">随机</button>
          </div>
        </div>
        <div class="anima-field">
          <label :for="idOf('steps')">采样步数</label>
          <input :id="idOf('steps')" v-model.number="steps" type="number" min="1" max="60" class="anima-num" :disabled="busy || capabilities.promptFormat === 'natural-language'" />
        </div>
        <div class="anima-field">
          <label :for="idOf('cfg')">引导强度 · CFG</label>
          <input :id="idOf('cfg')" v-model.number="cfg" type="number" min="0.5" max="10" step="0.5" class="anima-num" :disabled="busy || capabilities.promptFormat === 'natural-language'" />
        </div>
        <div class="anima-field">
          <label :for="idOf('size')">画布尺寸</label>
          <StudioSelect :id="idOf('size')" v-model="size" label="画布尺寸" :disabled="busy"
            :options="availableSizes.map(item => ({ value: item, label: item.replace('x', '×') }))" />
        </div>
      </div>
      <p class="anima-output-note tw:flex tw:flex-wrap tw:items-center tw:gap-[6px] tw:p-[10px] tw:rounded-sm tw:text-primary"><ArchiveIcon name="spark" />预计成片 {{ outputSize }}<span>放大倍率越高，显存与等待时间通常越多</span></p>

      <!-- 加速与高清修复控制（由能力表驱动，当前仅 Anima 开启） -->
      <div v-if="capabilities.hires || capabilities.teaCache" class="anima-row anima-hires-row">
        <ToggleSwitch v-model="teaCache" :disabled="busy" label="TeaCache 特征缓存加速" class="anima-hires-toggle">
          <ArchiveIcon name="lightning" class="anima-hires-icon" />
          <span>特征缓存加速 · TeaCache</span>
        </ToggleSwitch>
        <ToggleSwitch v-model="hiresFix" :disabled="busy" label="高清放大修复" class="anima-hires-toggle">
          <ArchiveIcon name="spark" class="anima-hires-icon" />
          <span>高清放大</span>
        </ToggleSwitch>
        <template v-if="hiresFix">
          <label :for="idOf('scale')" class="anima-inline tw:text-label-xs tw:text-secondary">倍率</label>
          <StudioSelect :id="idOf('scale')" v-model.number="hiresScale" label="倍率" :disabled="busy"
            :options="[{ value: 1.5, label: '1.5×' }, { value: 2.0, label: '2.0×' }]" />
          <label :for="idOf('denoise')" class="anima-inline tw:text-label-xs tw:text-secondary">重绘幅度</label>
          <input :id="idOf('denoise')" v-model.number="hiresDenoise" type="number" min="0.15" max="0.6" step="0.05" class="anima-num" :disabled="busy" />
        </template>
      </div>

      <details class="anima-prompt-details"><summary>查看引擎接收的提示词</summary>
      <label :for="idOf('prompt')" class="anima-label tw:mt-[4px]">正向提示词</label>
      <textarea :id="idOf('prompt')" :value="state.prompt" rows="4" class="anima-textarea tw:w-full tw:rounded-sm tw:resize-y" readonly></textarea>

       <template v-if="capabilities.negative">
         <label :for="idOf('negative')" class="anima-label tw:mt-[4px]">负向提示词</label>
         <textarea :id="idOf('negative')" :value="state.negative" rows="2" class="anima-textarea tw:w-full tw:rounded-sm tw:resize-y" readonly></textarea>
       </template>

      </details>
      <div v-if="busy" class="anima-progress tw:grid tw:gap-[5px] tw:mt-[4px]" aria-live="polite">
        <div class="anima-progress-copy tw:flex tw:justify-between tw:gap-[8px] tw:text-secondary tw:text-label-xs">
          <span>{{ state.progressText || state.statusText || 'ComfyUI 正在推理…' }}<template v-if="state.currentNode"> · 节点 {{ state.currentNode }}</template></span>
          <strong v-if="state.progress !== null">{{ Math.round(state.progress * 100) }}%</strong>
          <strong v-else>进行中</strong>
        </div>
        <div class="anima-progress-track tw:h-[5px] tw:overflow-hidden tw:rounded-pill" role="progressbar" :aria-valuenow="state.progress !== null ? Math.round(state.progress * 100) : undefined" aria-valuemin="0" aria-valuemax="100" :aria-label="state.progress !== null ? 'ComfyUI 生成进度' : 'ComfyUI 生成进行中'">
          <i :class="{ indeterminate: state.progress === null }" :style="progressStyle"></i>
        </div>
        <small>已等待 {{ Math.floor(state.elapsedSeconds / 60) }}分 {{ state.elapsedSeconds % 60 }}秒 · 最长等待 10 分钟</small>
      </div>
      <div class="anima-actions tw:min-w-0 tw:flex-wrap tw:flex tw:items-center tw:gap-[10px] tw:mt-[4px]" aria-live="polite">
        <span v-if="state.statusText && !state.errorReport" class="anima-status-text tw:text-label-xs tw:text-secondary">{{ state.statusText }}</span>
        <!--
          失败时给「为什么 + 怎么办」而不是一句红色英文技术串（2026-08-30 UX 审计）。
          分类报告与 SD 路径同源（backend='comfy'，文案不提 WebUI），原始串折进
          技术细节，避免污染主文案。重试直接重发当前面板配置，是 Comfy 侧唯一
          确定有效的恢复动作。
        -->
        <div v-if="state.errorReport" class="anima-error-block tw:flex tw:flex-col tw:gap-[4px]" role="alert">
          <span class="anima-error tw:text-label-xs tw:text-danger-text">{{ state.errorReport.title }}：{{ state.errorReport.message }}</span>
          <div class="anima-error-actions tw:flex tw:items-center tw:gap-[8px] tw:flex-wrap">
            <button class="anima-retry tw:rounded-sm tw:cursor-pointer tw:text-danger-text" type="button" :disabled="busy" @click="$emit('retry')">重试</button>
            <details v-if="state.errorReport.details" class="anima-error-detail">
              <summary>技术细节</summary>
              <code>{{ state.errorReport.details }}</code>
            </details>
          </div>
        </div>
        <span v-else-if="state.errorMsg" class="anima-error tw:text-label-xs tw:text-danger-text">{{ state.errorMsg }}</span>
      </div>
    </div>
  </details>
</template>

<style scoped>
@reference "../assets/css/tailwind.css";
.anima-quick-panel { @apply tw:mt-[14px] tw:min-w-0 tw:border-strong; background: var(--bg-surface) }
.anima-status { @apply tw:ml-auto tw:text-label-xs; padding: 2px 8px; @apply tw:rounded-pill }
.anima-status.is-on { @apply tw:text-success-text; background: color-mix(in srgb, var(--success) 12%, transparent) }
.anima-status.is-off { @apply tw:text-danger-text; background: color-mix(in srgb, var(--danger) 12%, transparent) }
.anima-body { padding: 12px 14px 14px }
.anima-row { @apply tw:flex tw:items-center tw:gap-[6px] tw:flex-wrap }
.anima-hires-row { @apply tw:pt-[6px]; border-top: 1px dashed var(--border-soft); @apply tw:mt-[2px] }
.anima-hires-toggle { @apply tw:text-label-xs tw:font-semibold tw:text-accent tw:max-w-full tw:flex-wrap }
.anima-hires-icon { @apply tw:w-[14px] tw:h-[14px] tw:text-accent tw:shrink-0 }
.anima-row label, .anima-label { @apply tw:text-label-xs tw:text-secondary tw:min-w-[44px] }
/* 原生 <select> 已迁移为 StudioSelect：外观由组件统一提供；行内布局（flex/min-width）
   由 .studio-select-wrapper 承接，保持 LoRA / 倍率与原生 select 一致的拉伸行为。 */
.anima-row .studio-select-wrapper { flex: 1; @apply tw:min-w-[120px] }
.anima-num { background: var(--bg-deep); color: inherit; border: 1px solid var(--border-soft); @apply tw:rounded-md; padding: 4px 8px; @apply tw:text-label-xs }
.anima-num { @apply tw:w-[72px] }
.anima-seed { @apply tw:w-[140px] }
/* 行内标签原本是裸 span，改为 label 后会继承上一行 .anima-row label 的 44px
   最小宽，把 Steps/CFG/尺寸撑开。这里还原成原来的紧凑外观，只换语义不换版式 */
.anima-row label.anima-inline { @apply tw:min-w-0 }
.anima-textarea { background: var(--bg-deep); color: inherit; border: 1px solid var(--border-soft); padding: 6px 8px; @apply tw:text-label-xs; font-family: inherit }
.anima-progress-copy strong { @apply tw:text-accent; font: 700 var(--fs-mono-xs) var(--font-mono); }
.anima-progress-track { background: var(--bg-deep); }
.anima-progress-track i { @apply tw:block tw:w-full tw:h-full; transform-origin: left center; transform: scaleX(var(--progress, 0)); background: linear-gradient(90deg, var(--archive-cyan), var(--accent)); transition: transform var(--motion-surface) var(--ease-out); }
.anima-progress-track i.indeterminate { @apply tw:w-[38%]; transform: translateX(-120%); animation: anima-progress-flow 1.15s linear infinite; }
.anima-progress small { @apply tw:text-muted tw:text-mono-xs; }
@keyframes anima-progress-flow { to { transform: translateX(290%); } }
@media (prefers-reduced-motion: reduce) { .anima-progress-track i.indeterminate { animation: none; transform: translateX(0); } }
.anima-actions { overflow-wrap: anywhere }
.anima-btn { background: var(--bg-hover); color: inherit; border: 1px solid var(--border-soft); padding: 5px 12px }
/* 审计修复: 不用 opacity 压字 */
.anima-btn:disabled { @apply tw:text-disabled tw:border-soft tw:cursor-not-allowed }
.anima-primary { background: var(--accent); @apply tw:border-accent tw:text-inverse tw:font-semibold }
.anima-retry {
  font: inherit; @apply tw:text-label-xs tw:font-semibold;
  padding: 2px 10px; background: color-mix(in srgb, var(--danger) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--danger) 45%, var(--border-soft));
}
.anima-retry:hover:not(:disabled) { background: color-mix(in srgb, var(--danger) 24%, transparent) }
.anima-retry:disabled { @apply tw:cursor-not-allowed tw:text-disabled tw:border-soft; background: transparent }
.anima-error-detail summary { @apply tw:text-label-xs tw:text-secondary tw:cursor-pointer }
.anima-error-detail code {
  @apply tw:block tw:mt-[4px]; padding: 6px 8px; @apply tw:rounded-sm;
  background: var(--bg-deep); @apply tw:text-label-xs tw:leading-label tw:whitespace-pre-wrap; word-break: break-word;
}
.anima-result { @apply tw:mt-[8px] }
.anima-result img { @apply tw:max-w-full tw:rounded-lg; border: 1px solid var(--border-soft) }
.anima-parameter-grid { grid-template-columns: repeat(auto-fit, minmax(min(100%, 8rem), 1fr)); }
.anima-field { @apply tw:grid; align-content: start; @apply tw:gap-s-2 tw:min-w-0 tw:p-s-3; border: 1px solid var(--border-soft); @apply tw:rounded-md; background: var(--bg-base); }
.anima-field label { @apply tw:text-secondary tw:text-label-xs; }
.anima-field .anima-num { @apply tw:w-full tw:min-w-0 tw:min-h-[40px] tw:box-border; font-variant-numeric: tabular-nums; background: var(--bg-surface); }
.anima-seed-field { grid-column: 1 / -1; }
.anima-seed-control .anima-seed { flex: 1; @apply tw:w-0; }
.anima-seed-control .anima-btn { @apply tw:shrink-0; }
.anima-output-note { margin: 4px 0; border: 1px solid var(--border-soft); background: var(--accent-soft); @apply tw:text-label-xs; font-variant-numeric: tabular-nums; }
.anima-output-note svg { @apply tw:w-[16px] tw:h-[16px] tw:text-accent tw:shrink-0; }
.anima-output-note span { flex-basis: 100%; @apply tw:text-secondary; }
.anima-quick-panel input:disabled { opacity: 1; @apply tw:text-disabled; -webkit-text-fill-color: var(--text-disabled); @apply tw:cursor-not-allowed; }
.anima-quick-panel :is(input, textarea, button, summary):focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.anima-quick-panel :is(button):active:not(:disabled) { transform: scale(.97); }
.anima-progress-copy > span, .anima-error-block { @apply tw:min-w-0; overflow-wrap: anywhere; }
.anima-status { @apply tw:whitespace-nowrap; }
.anima-quick-panel > summary > span:first-child { @apply tw:min-w-0; overflow-wrap: anywhere; }
</style>
