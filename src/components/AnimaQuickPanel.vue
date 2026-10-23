<script setup lang="ts">
import { computed, useId } from 'vue'
import { RouterLink } from 'vue-router'
import type { AnimaGenerationState } from '@/types/anima'
import { resolveDrawCapabilities } from '@/utils/drawCapabilities'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import ToggleSwitch from '@/components/visual/ToggleSwitch.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'

const props = defineProps<{
  state: AnimaGenerationState
  /** 热门角色无 LoRA 模式（由父级按 subject + capability 判定，面板不做模型 id 猜测）。 */
  noLora?: boolean
}>()
const state = computed(() => props.state)
const native = computed(() => props.state.provider === 'native')
const emit = defineEmits<{
  (event: 'update:state', patch: Partial<AnimaGenerationState>): void
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
const styleLoraId = computed({ get: () => props.state.styleLoraId, set: value => patch({ styleLoraId: value }) })
const loraStrength = computed({ get: () => props.state.loraStrength, set: value => patch({ loraStrength: value }) })
const seed = computed({ get: () => props.state.seed ?? '', set: value => patch({ seed: value === '' ? null : Number(value) }) })
const steps = computed({ get: () => props.state.steps, set: value => patch({ steps: value }) })
const cfg = computed({ get: () => props.state.cfg, set: value => patch({ cfg: value }) })
const teaCache = computed({ get: () => props.state.teaCache !== false,
  set: value => patch({ teaCache: value }) })
const cacheThreshold = computed(() => props.state.teaCacheThresh ?? 0.10)
function updateCacheThreshold(event: Event) {
  const input = event.target as HTMLInputElement
  if (input.validity.valid && Number.isFinite(input.valueAsNumber)) patch({ teaCacheThresh: input.valueAsNumber })
  else input.value = String(cacheThreshold.value)
}
const hiresFix = computed({ get: () => Boolean(props.state.hiresFix), set: value => patch({ hiresFix: value }) })
const hiresScale = computed({ get: () => props.state.hiresScale || 2.0, set: value => patch({ hiresScale: value }) })
const hiresDenoise = computed({ get: () => props.state.hiresDenoise || 0.35, set: value => patch({ hiresDenoise: value }) })
const hiresUpscaler = computed({ get: () => props.state.hiresUpscaler || 'Auto', set: (value: 'Auto' | 'Latent' | 'Remacri') => patch({ hiresUpscaler: value }) })
const comfyHiresPath = computed(() => {
  if (hiresUpscaler.value === 'Latent') return 'latent'
  if (hiresUpscaler.value === 'Remacri') return 'pixel'
  if (props.state.autoHiresModel === undefined) return 'unknown'
  return props.state.autoHiresModel ? 'pixel' : 'latent'
})
const comfyUpscalers = computed(() => [
  { value: 'Auto', label: 'Auto · 按已识别资源' }, { value: 'Latent', label: 'Latent · 二次重绘' },
  ...(hiresUpscaler.value === 'Remacri' ? [{ value: 'Remacri', label: 'Remacri · 已保存选择' }] : []),
])
const busy = computed(() => ['submitting', 'running', 'cancelling'].includes(props.state.phase))
const outputSize = computed(() => {
  const scale = props.state.hiresFix ? (props.state.hiresScale ?? 2) : 1
  return `${Math.round(props.state.width * scale / 8) * 8} × ${Math.round(props.state.height * scale / 8) * 8}`
})
const selectedModel = computed(() => props.state.models.find(model => model.id === props.state.modelId) ?? null)
const selectedLora = computed(() => props.state.loras.find(lora => lora.id === props.state.loraId) ?? null)
/** 当前底模能力表：引擎默认值 + 后端模型能力合并（UI 不再按 family 散落判断）。 */
const capabilities = computed(() => resolveDrawCapabilities(props.state.family, null, selectedModel.value?.capabilities ?? null))
const nativeAnima = computed(() => native.value && props.state.family === 'anima')
const fixedSampling = computed(() => selectedModel.value?.capabilities?.fixedSampling ?? (!native.value && props.state.family === 'krea2'))
/** 热门角色无 LoRA：只在 popular subject + noLora capability 时隐藏 LoRA 选择。 */
const noLoraMode = computed(() => props.noLora === true && selectedModel.value?.capabilities?.noLora === true)
function randomSeed() { patch({ seed: Math.floor(Math.random() * 1_000_000_000) }) }
</script>

<template>
  <section class="panel step-panel anima-quick-panel" aria-label="引擎采样参数">
    <div class="panel-title anima-heading">
       <span>{{ state.family === 'krea2' ? 'Krea 2 · 生成参数' : 'Anima · 生成参数' }}</span>
      <span class="anima-status" :class="state.online ? 'is-on' : 'is-off'">{{ state.online ? '在线' : '离线' }}</span>
    </div>
    <div class="anima-body">
       <p class="anima-hint tw:text-label-xs tw:text-secondary tw:m-0">{{ state.checkMsg }}</p>
       <RouterLink v-if="state.family === 'krea2' && !state.online" class="btn btn-ghost anima-setup-link" :to="{ path: '/control', query: { engine: 'krea2' } }">查看 Krea 环境与准备范围</RouterLink>
       <p v-if="capabilities.promptFormat === 'natural-language'" class="anima-preview-note tw:m-0 tw:text-warning-text tw:text-label-xs tw:leading-label"><strong>Krea 2 实验</strong> · 纯自然语言、无角色 LoRA，身份还原需以实际出图为准。</p>
        <p v-else-if="noLoraMode" class="anima-preview-note tw:m-0 tw:text-warning-text tw:text-label-xs tw:leading-label"><strong>无需 LoRA</strong> · 通用底模直出，不加载角色 LoRA，身份由词条锚定</p>
        <p v-else-if="selectedLora?.preview" class="anima-preview-note tw:m-0 tw:text-warning-text tw:text-label-xs tw:leading-label"><strong>实验预览</strong> · 此 LoRA 为实验版</p>

       <div v-if="capabilities.lora && !noLoraMode" class="anima-field anima-lora-fields">
        <div class="anima-form-field">
          <label :for="idOf('lora')">LoRA</label>
          <StudioSelect :id="idOf('lora')" v-model="loraId" label="LoRA" :disabled="busy"
            :options="state.loras.map(l => ({ value: l.id, label: l.name || l.id }))" />
        </div>
        <div class="anima-form-field">
          <label :for="idOf('strength')">强度</label>
          <input :id="idOf('strength')" v-model.number="loraStrength" type="number" min="0.65" max="1" step="0.05" class="anima-num" :disabled="busy" />
        </div>
       </div>
       <div v-if="state.family === 'krea2' && state.styleLoras.length" class="anima-field">
         <label :for="idOf('style')">官方风格 LoRA</label>
         <StudioSelect :id="idOf('style')" v-model="styleLoraId" label="官方风格 LoRA" :disabled="busy"
           :options="[{ value: '', label: '不使用风格 LoRA' }, ...state.styleLoras.map(style => ({ value: style.id, label: `${style.id}${style.available ? '' : ' · 未安装'}`, disabled: !style.available }))]" />
       </div>
      <div class="anima-parameter-grid">
        <div class="anima-field anima-seed-field">
          <label :for="idOf('seed')">随机种子</label>
          <div class="anima-seed-control">
            <input :id="idOf('seed')" v-model.number="seed" type="number" min="0" step="1" class="anima-num" :disabled="busy" />
            <button type="button" class="btn btn-ghost" :disabled="busy" @click="randomSeed">随机</button>
          </div>
        </div>
        <div class="anima-field anima-field--slider">
          <div class="anima-field-heading">
            <label :for="idOf('steps')">采样步数</label>
            <input :id="idOf('steps')" v-model.number="steps" type="number" min="1" max="60" class="anima-num" :disabled="busy || fixedSampling" />
          </div>
          <input type="range" min="1" max="60" step="1" :value="steps"
            class="anima-slider" aria-label="采样步数滑块" :disabled="busy || fixedSampling"
            @input="steps = Number(($event.target as HTMLInputElement).value)" />
        </div>
        <div class="anima-field anima-field--slider">
          <div class="anima-field-heading">
            <label :for="idOf('cfg')">引导强度 · CFG</label>
            <input :id="idOf('cfg')" v-model.number="cfg" type="number" :min="state.family === 'krea2' ? 0 : 0.5" max="10" step="0.5" class="anima-num" :disabled="busy || fixedSampling" />
          </div>
          <input type="range" :min="state.family === 'krea2' ? 0 : 0.5" max="10" step="0.5" :value="cfg"
            class="anima-slider" aria-label="引导强度滑块" :disabled="busy || fixedSampling"
            @input="cfg = Number(($event.target as HTMLInputElement).value)" />
        </div>
      </div>
      <p class="anima-output-note"><ArchiveIcon name="spark" />预计成片 {{ outputSize }}<span>放大倍率越高，显存与等待时间通常越多</span></p>

      <!-- 加速与高清修复控制（由能力表驱动，当前仅 Anima 开启） -->
      <div v-if="nativeAnima || capabilities.hires || capabilities.teaCache || hiresFix || teaCache" class="anima-hires-options">
        <ToggleSwitch v-model="teaCache" :disabled="busy || (!capabilities.teaCache && !teaCache)" label="TeaCache 特征缓存加速" class="anima-hires-toggle">
          <ArchiveIcon name="lightning" class="anima-hires-icon" />
          <span>特征缓存加速 · TeaCache</span>
        </ToggleSwitch>
        <div v-if="(nativeAnima || capabilities.teaCache) && teaCache" class="anima-field anima-field--slider">
          <div class="anima-field-heading">
            <label :for="idOf('cache-threshold')">缓存阈值</label>
            <input :id="idOf('cache-threshold')" type="number" min="0" max="0.15" step="0.01" :value="cacheThreshold" class="anima-num" :disabled="busy" :aria-describedby="idOf('cache-threshold-hint')" @change="updateCacheThreshold" />
          </div>
          <input type="range" min="0" max="0.15" step="0.01" :value="cacheThreshold" class="anima-slider" aria-label="TeaCache 缓存阈值滑块" :aria-describedby="idOf('cache-threshold-hint')" :disabled="busy" @input="updateCacheThreshold" />
          <span :id="idOf('cache-threshold-hint')" class="tw:text-label-xs tw:text-secondary">范围 0–0.15 · 默认 0.10 · 数值越低越保守，0 为完整计算</span>
        </div>
        <ToggleSwitch v-model="hiresFix" :disabled="busy || (!(native ? selectedModel?.capabilities?.hires === true : capabilities.hires) && !hiresFix)" label="高清放大修复" class="anima-hires-toggle">
          <ArchiveIcon name="spark" class="anima-hires-icon" />
          <span>高清放大</span>
        </ToggleSwitch>
        <div v-if="hiresFix" class="anima-parameter-grid">
          <div class="anima-field">
            <label :for="idOf('upscaler')">放大方式</label>
            <StudioSelect v-if="native" :id="idOf('upscaler')" v-model="hiresUpscaler" label="放大方式" :disabled="busy"
              :options="[{ value: 'Auto', label: 'Auto · 优先 Remacri' }, { value: 'Latent', label: 'Latent · 二次采样' }, { value: 'Remacri', label: 'Remacri', disabled: !selectedModel?.capabilities?.hiresUpscalers?.includes('Remacri') }]" />
            <StudioSelect v-else :id="idOf('upscaler')" v-model="hiresUpscaler" label="放大方式" :disabled="busy" :options="comfyUpscalers" />
          </div>
          <div class="anima-field">
            <label :for="idOf('scale')">倍率</label>
            <StudioSelect :id="idOf('scale')" v-model.number="hiresScale" label="倍率" :disabled="busy"
              :options="[{ value: 1.5, label: '1.5×' }, { value: 2.0, label: '2.0×' }]" />
          </div>
          <div class="anima-field">
            <label :for="idOf('denoise')">二次重绘幅度</label>
            <input :id="idOf('denoise')" v-model.number="hiresDenoise" type="number" min="0.15" max="0.6" step="0.05" class="anima-num" :disabled="busy || (!native && comfyHiresPath !== 'latent')" />
          </div>
        </div>
      </div>
      <p v-if="!native && hiresFix" class="anima-hint tw:text-label-xs tw:text-secondary tw:m-0">
        <template v-if="comfyHiresPath === 'unknown'">Auto 放大路径待确认，请刷新引擎状态；暂不调整二次重绘幅度。</template>
        <template v-else-if="comfyHiresPath === 'pixel'">按当前资源，普通出图采用像素放大{{ hiresUpscaler === 'Auto' && state.autoHiresModel ? `（${state.autoHiresModel}）` : '' }}，不做二次采样，因此此处幅度不生效。选择 Latent 可进行二次重绘。</template>
        <template v-else>按当前资源，普通出图采用 Latent 二次重绘，幅度控制这一次采样。最终文件在提交时重新核对。</template>
        局部蒙版高清另有二次采样与合成，仍使用保存的幅度；切换放大方式不会清除该值。
      </p>
      <p v-if="native && hiresFix" class="anima-hint tw:text-label-xs tw:text-secondary tw:m-0">高清采样沿用特征缓存设置，无需额外配置。Auto 优先使用本地 Remacri，否则使用 Latent；局部重绘保留遮罩合成。</p>
      <RouterLink v-if="native && hiresFix && !selectedModel?.capabilities?.hiresUpscalers?.includes('Remacri')" class="btn btn-quiet btn-sm" :to="{ path: '/control', query: { resource: 'remacri-4x' }, hash: '#control-setup' }">准备 Remacri 高清放大</RouterLink>
      <p v-if="nativeAnima" class="anima-hint tw:text-label-xs tw:text-secondary tw:m-0">
        已内置 Anima TeaCache，换角色、尺寸或高清倍率无需校准。缓存会改变部分采样结果，可关闭以使用完整计算。
      </p>

      <details class="anima-prompt-details"><StudioDisclosureSummary>查看引擎接收的提示词</StudioDisclosureSummary><div data-disclosure-content>
      <label :for="idOf('prompt')" class="anima-label">正向提示词</label>
      <textarea :id="idOf('prompt')" :value="state.prompt" rows="4" class="anima-textarea" readonly></textarea>

       <template v-if="capabilities.negative">
         <label :for="idOf('negative')" class="anima-label">负向提示词</label>
         <textarea :id="idOf('negative')" :value="state.negative" rows="2" class="anima-textarea" readonly></textarea>
       </template>

      </div></details>
    </div>
  </section>
</template>

<style scoped>
.anima-quick-panel { min-width:0; margin:0; }
.anima-heading { display:flex; align-items:center; gap:var(--s-2); }
.anima-heading > span:first-child { min-width:0; overflow-wrap:anywhere; }
.anima-status { display:inline-flex; align-items:center; flex:none; gap:var(--s-1); margin-inline-start:auto; padding:2px var(--s-2); border-radius:var(--r-pill); font-size:var(--fs-label-xs); white-space:nowrap; }
.anima-status::before { content:''; width:6px; height:6px; border:1px solid currentColor; border-radius:50%; background:currentColor; }
.anima-status.is-on { color:var(--success-text); background:color-mix(in srgb,var(--success) 12%,var(--bg-surface)); }
.anima-status.is-off { color:var(--danger-text); background:color-mix(in srgb,var(--danger) 12%,var(--bg-surface)); }
.anima-status.is-off::before { background:transparent; }
.anima-body { display:grid; gap:var(--s-3); min-width:0; }
.anima-setup-link { justify-self:start; white-space:normal; text-align:left; }
/* Each slider keeps its label beside a bounded number field. The cards wrap
   before either Chinese label needs to squeeze into a narrow column. */
.anima-parameter-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,13rem),1fr)); gap:var(--s-2); min-width:0; }
.anima-field { display:grid; align-content:start; gap:var(--s-2); min-width:0; padding:var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--bg-base); }
.anima-form-field { display:grid; align-content:start; gap:var(--s-2); min-width:0; }
.anima-lora-fields { grid-template-columns:minmax(0,1fr) minmax(0,5rem); }
.anima-field label,.anima-label { color:var(--text-secondary); font-size:var(--fs-label); line-height:var(--lh-label); }
.anima-field .studio-select-wrapper { width:100%; min-width:0; }
.anima-num,.anima-textarea { width:100%; min-width:0; background:var(--bg-surface); font-size:var(--fs-label); font-variant-numeric:tabular-nums; }
.anima-field-heading { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:var(--s-2); min-width:0; }
.anima-field-heading .anima-num { flex:0 0 5rem; width:5rem; }
.anima-slider { width:100%; }
.anima-seed-field { grid-column: 1 / -1; }
.anima-seed-control { display:flex; gap:var(--s-2); min-width:0; }
.anima-seed-control .anima-num { flex:1; width:0; }
.anima-seed-control .btn { flex:none; }
.anima-output-note { display:flex; flex-wrap:wrap; align-items:center; gap:var(--s-2); margin:0; padding:var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--accent-soft); color:var(--text-primary); font-size:var(--fs-label); line-height:var(--lh-body); font-variant-numeric:tabular-nums; }
.anima-output-note .archive-icon,.anima-hires-icon { flex:none; width:16px; height:16px; color:var(--accent); }
.anima-output-note span { flex-basis:100%; color:var(--text-secondary); font-size:var(--fs-label-sm); }
.anima-hires-options { display:grid; gap:var(--s-2); min-width:0; padding-top:var(--s-3); border-top:1px solid var(--border-soft); }
.anima-hires-toggle { width:100%; min-width:0; color:var(--text-secondary); font:400 var(--fs-label)/var(--lh-label) var(--font-sans); }
.anima-hires-toggle > span:last-child { flex:1; min-width:0; overflow-wrap:anywhere; }
.anima-label { display:block; margin:var(--s-2) 0; }
.anima-textarea { font-family:var(--font-mono); }
.anima-prompt-details { color:var(--text-muted); font-size:var(--fs-label-xs); }
.anima-prompt-details summary { padding-block:var(--s-2); color:var(--text-secondary); font-size:var(--fs-label); cursor:pointer; }
.anima-prompt-details textarea { margin-block:var(--s-2); }
.anima-quick-panel :is(.anima-num,.anima-textarea):disabled { color:var(--text-disabled); -webkit-text-fill-color:var(--text-disabled); cursor:not-allowed; }
.anima-quick-panel :is(.anima-num,.anima-textarea,summary):focus-visible { outline:none; box-shadow:var(--focus-shadow); }
</style>
