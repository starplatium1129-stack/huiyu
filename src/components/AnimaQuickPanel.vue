<script setup lang="ts">
import { computed, useId } from 'vue'
import type { AnimaGenerationState } from '@/types/anima'
import { resolveDrawCapabilities } from '@/utils/drawCapabilities'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import ToggleSwitch from '@/components/visual/ToggleSwitch.vue'

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
    <div class="anima-body">
       <p class="anima-hint">{{ state.checkMsg }}</p>
       <p v-if="capabilities.promptFormat === 'natural-language'" class="anima-preview-note"><strong>Krea 2 实验</strong> · 纯自然语言、无角色 LoRA，身份还原需以实际出图为准。</p>
        <p v-else-if="noLoraMode" class="anima-preview-note"><strong>无需 LoRA</strong> · 通用底模直出，不加载角色 LoRA，身份由词条锚定</p>
        <p v-else-if="selectedLora?.preview" class="anima-preview-note"><strong>实验预览</strong> · 此 LoRA 为实验版</p>

       <div v-if="capabilities.lora && !noLoraMode" class="anima-row">
        <label :for="idOf('lora')">LoRA</label>
        <select :id="idOf('lora')" v-model="loraId" :disabled="busy">
          <option v-for="l in state.loras" :key="l.id" :value="l.id">{{ l.name || l.id }}</option>
        </select>
        <label :for="idOf('strength')" class="anima-inline">强度</label>
        <input :id="idOf('strength')" v-model.number="loraStrength" type="number" min="0.65" max="1" step="0.05" class="anima-num" :disabled="busy" />
       </div>
      <div class="anima-parameter-grid">
        <div class="anima-field anima-seed-field">
          <label :for="idOf('seed')">随机种子</label>
          <div class="anima-seed-control">
            <input :id="idOf('seed')" v-model.number="seed" type="number" min="0" step="1" class="anima-num anima-seed" :disabled="busy" />
            <button type="button" class="anima-btn" :disabled="busy" @click="randomSeed">随机</button>
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
          <select :id="idOf('size')" v-model="size" class="anima-num" :disabled="busy">
            <option v-for="item in availableSizes" :key="item" :value="item">{{ item.replace('x', '×') }}</option>
          </select>
        </div>
      </div>
      <p class="anima-output-note"><ArchiveIcon name="spark" />预计成片 {{ outputSize }}<span>放大倍率越高，显存与等待时间通常越多</span></p>

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
          <label :for="idOf('scale')" class="anima-inline">倍率</label>
          <select :id="idOf('scale')" v-model.number="hiresScale" class="anima-num" :disabled="busy">
            <option :value="1.5">1.5×</option>
            <option :value="2.0">2.0×</option>
          </select>
          <label :for="idOf('denoise')" class="anima-inline">重绘幅度</label>
          <input :id="idOf('denoise')" v-model.number="hiresDenoise" type="number" min="0.15" max="0.6" step="0.05" class="anima-num" :disabled="busy" />
        </template>
      </div>

      <details class="anima-prompt-details"><summary>查看引擎接收的提示词</summary>
      <label :for="idOf('prompt')" class="anima-label">正向提示词</label>
      <textarea :id="idOf('prompt')" :value="state.prompt" rows="4" class="anima-textarea" readonly></textarea>

       <template v-if="capabilities.negative">
         <label :for="idOf('negative')" class="anima-label">负向提示词</label>
         <textarea :id="idOf('negative')" :value="state.negative" rows="2" class="anima-textarea" readonly></textarea>
       </template>

      </details>
      <div v-if="busy" class="anima-progress" aria-live="polite">
        <div class="anima-progress-copy">
          <span>{{ state.progressText || state.statusText || 'ComfyUI 正在推理…' }}<template v-if="state.currentNode"> · 节点 {{ state.currentNode }}</template></span>
          <strong v-if="state.progress !== null">{{ Math.round(state.progress * 100) }}%</strong>
          <strong v-else>进行中</strong>
        </div>
        <div class="anima-progress-track" role="progressbar" :aria-valuenow="state.progress !== null ? Math.round(state.progress * 100) : undefined" aria-valuemin="0" aria-valuemax="100" :aria-label="state.progress !== null ? 'ComfyUI 生成进度' : 'ComfyUI 生成进行中'">
          <i :class="{ indeterminate: state.progress === null }" :style="progressStyle"></i>
        </div>
        <small>已等待 {{ Math.floor(state.elapsedSeconds / 60) }}分 {{ state.elapsedSeconds % 60 }}秒 · 最长等待 10 分钟</small>
      </div>
      <div class="anima-actions" aria-live="polite">
        <span v-if="state.statusText && !state.errorReport" class="anima-status-text">{{ state.statusText }}</span>
        <!--
          失败时给「为什么 + 怎么办」而不是一句红色英文技术串（2026-08-30 UX 审计）。
          分类报告与 SD 路径同源（backend='comfy'，文案不提 WebUI），原始串折进
          技术细节，避免污染主文案。重试直接重发当前面板配置，是 Comfy 侧唯一
          确定有效的恢复动作。
        -->
        <div v-if="state.errorReport" class="anima-error-block" role="alert">
          <span class="anima-error">{{ state.errorReport.title }}：{{ state.errorReport.message }}</span>
          <div class="anima-error-actions">
            <button class="anima-retry" type="button" :disabled="busy" @click="$emit('retry')">重试</button>
            <details v-if="state.errorReport.details" class="anima-error-detail">
              <summary>技术细节</summary>
              <code>{{ state.errorReport.details }}</code>
            </details>
          </div>
        </div>
        <span v-else-if="state.errorMsg" class="anima-error">{{ state.errorMsg }}</span>
      </div>
    </div>
  </details>
</template>

<style scoped>
.anima-quick-panel { margin-top: 14px; min-width: 0; border-color: var(--border-strong); background: var(--bg-surface) }
.anima-status { margin-left: auto; font-size: var(--fs-label-xs); padding: 2px 8px; border-radius: var(--r-pill) }
.anima-status.is-on { color: var(--success-text); background: color-mix(in srgb, var(--success) 12%, transparent) }
.anima-status.is-off { color: var(--danger-text); background: color-mix(in srgb, var(--danger) 12%, transparent) }
.anima-body { padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 8px }
.anima-hint { font-size: var(--fs-label-xs); color: var(--text-secondary); margin: 0 }
.anima-preview-note { margin: 0; color: var(--warning-text); font-size: var(--fs-label-xs); line-height: var(--lh-label)}
.anima-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap }
.anima-hires-row { padding-top: 6px; border-top: 1px dashed var(--border-soft); margin-top: 2px }
.anima-hires-toggle { font-size: var(--fs-label-xs); font-weight: 600; color: var(--accent) }
.anima-hires-icon { width: 14px; height: 14px; color: var(--accent); flex-shrink: 0 }
.anima-row label, .anima-label { font-size: var(--fs-label-xs); color: var(--text-secondary); min-width: 44px }
.anima-label { margin-top: 4px }
.anima-row select, .anima-field select {
  background-color: var(--bg-deep);
  color: inherit;
  border: 1px solid var(--border-soft);
  border-radius: var(--r-md);
  padding: 6px var(--s-7) 6px 10px;
  font-size: var(--fs-label-xs);
  cursor: pointer;
  outline: none;
  -webkit-appearance: none;
  appearance: none;
  background-image:
    linear-gradient(45deg, transparent 50%, var(--text-muted) 50%),
    linear-gradient(135deg, var(--text-muted) 50%, transparent 50%);
  background-repeat: no-repeat;
  background-position:
    calc(100% - 12px) calc(50% - 1px),
    calc(100% - 8px) calc(50% - 1px);
  background-size: 4px 4px;
  transition: border-color var(--motion-hover) var(--ease-out);
}
.anima-row select:hover, .anima-field select:hover { border-color: var(--accent); }
.anima-row select:focus-visible, .anima-field select:focus-visible { border-color: var(--accent); outline: 2px solid var(--accent); outline-offset: 2px; }
.anima-num { background: var(--bg-deep); color: inherit; border: 1px solid var(--border-soft); border-radius: var(--r-md); padding: 4px 8px; font-size: var(--fs-label-xs) }
.anima-row select { flex: 1; min-width: 120px }
.anima-num { width: 72px }
.anima-seed { width: 140px }
.anima-inline { font-size: var(--fs-label-xs); color: var(--text-secondary) }
/* 行内标签原本是裸 span，改为 label 后会继承上一行 .anima-row label 的 44px
   最小宽，把 Steps/CFG/尺寸撑开。这里还原成原来的紧凑外观，只换语义不换版式 */
.anima-row label.anima-inline { min-width: 0 }
.anima-textarea { width: 100%; background: var(--bg-deep); color: inherit; border: 1px solid var(--border-soft); border-radius: var(--r-sm); padding: 6px 8px; font-size: var(--fs-label-xs); resize: vertical; font-family: inherit }
.anima-progress { display: grid; gap: 5px; margin-top: 4px; }
.anima-progress-copy { display: flex; justify-content: space-between; gap: 8px; color: var(--text-secondary); font-size: var(--fs-label-xs); }
.anima-progress-copy strong { color: var(--accent); font: 700 var(--fs-mono-xs) var(--font-mono); }
.anima-progress-track { height: 5px; overflow: hidden; border-radius: var(--r-pill); background: var(--bg-deep); }
.anima-progress-track i { display: block; width: 100%; height: 100%; transform-origin: left center; transform: scaleX(var(--progress, 0)); background: linear-gradient(90deg, var(--archive-cyan), var(--accent)); transition: transform var(--motion-surface) var(--ease-out); }
.anima-progress-track i.indeterminate { width: 38%; transform: translateX(-120%); animation: anima-progress-flow 1.15s linear infinite; }
.anima-progress small { color: var(--text-muted); font-size: var(--fs-mono-xs); }
@keyframes anima-progress-flow { to { transform: translateX(290%); } }
@media (prefers-reduced-motion: reduce) { .anima-progress-track i.indeterminate { animation: none; transform: translateX(0); } }
.anima-actions { min-width: 0; flex-wrap: wrap; overflow-wrap: anywhere; display: flex; align-items: center; gap: 10px; margin-top: 4px }
.anima-btn { background: var(--bg-hover); color: inherit; border: 1px solid var(--border-soft); border-radius: var(--r-sm); padding: 5px 12px; font-size: var(--fs-label-xs); cursor: pointer }
/* 审计修复: 不用 opacity 压字 */
.anima-btn:disabled { color: var(--text-disabled); border-color: var(--border-soft); cursor: not-allowed }
.anima-primary { background: var(--accent); border-color: var(--accent); color: var(--text-inverse); font-weight: 600 }
.anima-status-text { font-size: var(--fs-label-xs); color: var(--text-secondary) }
.anima-error { font-size: var(--fs-label-xs); color: var(--danger-text) }
.anima-error-block { display: flex; flex-direction: column; gap: 4px }
.anima-error-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap }
.anima-retry {
  font: inherit; font-size: var(--fs-label-xs); font-weight: 600;
  padding: 2px 10px; border-radius: var(--r-sm); cursor: pointer;
  color: var(--danger-text); background: color-mix(in srgb, var(--danger) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--danger) 45%, var(--border-soft));
}
.anima-retry:hover:not(:disabled) { background: color-mix(in srgb, var(--danger) 24%, transparent) }
.anima-retry:disabled { cursor: not-allowed; color: var(--text-disabled); border-color: var(--border-soft); background: transparent }
.anima-error-detail summary { font-size: var(--fs-label-xs); color: var(--text-secondary); cursor: pointer }
.anima-error-detail code {
  display: block; margin-top: 4px; padding: 6px 8px; border-radius: var(--r-sm);
  background: var(--bg-deep); font-size: var(--fs-label-xs); line-height: var(--lh-label);
  white-space: pre-wrap; word-break: break-word;
}
.anima-result { margin-top: 8px }
.anima-result img { max-width: 100%; border-radius: var(--r-lg); border: 1px solid var(--border-soft) }
.anima-parameter-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 120px), 1fr)); gap: var(--s-2); }
.anima-field { display: grid; align-content: start; gap: var(--s-2); min-width: 0; padding: var(--s-3); border: 1px solid var(--border-soft); border-radius: var(--r-md); background: var(--bg-base); }
.anima-field label { color: var(--text-secondary); font-size: var(--fs-label-xs); }
.anima-field .anima-num { width: 100%; min-width: 0; min-height: 40px; box-sizing: border-box; font-variant-numeric: tabular-nums; background: var(--bg-surface); }
.anima-seed-control { display: flex; gap: 6px; min-width: 0; }
.anima-seed-field { grid-column: 1 / -1; }
.anima-seed-control .anima-seed { flex: 1; width: 0; }
.anima-seed-control .anima-btn { flex-shrink: 0; }
.anima-output-note { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 10px; margin: 4px 0; border: 1px solid var(--border-soft); border-radius: var(--r-sm); color: var(--text-primary); background: var(--accent-soft); font-size: var(--fs-label-xs); font-variant-numeric: tabular-nums; }
.anima-output-note svg { width: 16px; height: 16px; color: var(--accent); flex-shrink: 0; }
.anima-output-note span { flex-basis: 100%; color: var(--text-secondary); }
.anima-quick-panel :is(input, select):disabled { opacity: 1; color: var(--text-disabled); -webkit-text-fill-color: var(--text-disabled); cursor: not-allowed; }
.anima-quick-panel :is(input, select, textarea, button, summary):focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.anima-quick-panel :is(button):active:not(:disabled) { transform: scale(.97); }
.anima-progress-copy > span, .anima-error-block { min-width: 0; overflow-wrap: anywhere; }
.anima-status { white-space: nowrap; }
.anima-quick-panel > summary > span:first-child { min-width: 0; overflow-wrap: anywhere; }
</style>
