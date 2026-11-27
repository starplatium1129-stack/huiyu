<script setup lang="ts">
import { computed, useId } from 'vue'
import { RouterLink } from 'vue-router'
import type { AnimaGenerationState } from '@/types/anima'
import { resolveDrawCapabilities } from '@/utils/drawCapabilities'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import ToggleSwitch from '@/components/visual/ToggleSwitch.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioSlider from '@/components/ui/StudioSlider.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import { ANIMA_HIRES_PRESET } from '@/config/animaHires'
import { kreaStyleLoraLabel } from '@/config/kreaStyleLoraLabels'
import { KREA_STYLE_RECIPES } from '@/config/kreaStyleRecipes'

const props = defineProps<{
  state: AnimaGenerationState
  /** 热门角色无 LoRA 模式（由父级按 subject + capability 判定，面板不做模型 id 猜测）。 */
  noLora?: boolean
  studioLoraDisabled?: boolean
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
function recommendedStyleStrength(id: string): number {
  const found = props.state.styleLoras.find(style => style.id === id)
  return found && Number.isFinite(found.recommendedStrength) ? found.recommendedStrength : 1
}
const styleLoraId = computed({
  get: () => props.state.styleLoraId,
  set: value => patch(value ? { styleLoraId: value, styleLoraStrength: recommendedStyleStrength(value) } : { styleLoraId: '' }),
})
const secondaryStyleLoraId = computed({
  get: () => props.state.secondaryStyleLoraId,
  set: value => patch(value ? { secondaryStyleLoraId: value, secondaryStyleLoraStrength: recommendedStyleStrength(value) } : { secondaryStyleLoraId: '' }),
})
const styleLoraStrength = computed({ get: () => props.state.styleLoraStrength, set: value => patch({ styleLoraStrength: value }) })
const secondaryStyleLoraStrength = computed({ get: () => props.state.secondaryStyleLoraStrength, set: value => patch({ secondaryStyleLoraStrength: value }) })
const styleOptions = computed(() => props.state.styleLoras.map(style => ({
  value: style.id, label: `${kreaStyleLoraLabel(style.id, style.label)}${style.available ? '' : ' · 未安装'}`, disabled: !style.available,
})))
const styleRecipeId = computed({ get: () => props.state.kreaStyleRecipeId, set: value => patch({ kreaStyleRecipeId: value }) })
const recipeOptions = [{ value: '', label: '跟随场景' }, ...KREA_STYLE_RECIPES.map(recipe => ({ value: recipe.id, label: recipe.name }))]
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
const hiresScale = computed({ get: () => props.state.hiresScale ?? 1.5, set: value => patch({ hiresScale: value }) })
const hiresDenoise = computed({ get: () => props.state.hiresDenoise ?? 0.8, set: value => patch({ hiresDenoise: value }) })
const hiresSteps = computed({ get: () => props.state.hiresSteps ?? 10, set: value => patch({ hiresSteps: value }) })
const hiresCfg = computed({ get: () => props.state.hiresCfg ?? 5.5, set: value => patch({ hiresCfg: value }) })
const hiresUpscaler = computed(() => props.state.hiresUpscaler || '4x-UltraSharp')
const hiresMode = computed({
  get: () => hiresFix.value ? hiresUpscaler.value : '',
  set: (value: NonNullable<AnimaGenerationState['hiresUpscaler']> | '') => {
    if (!value) patch({ hiresFix: false })
    else if (value === '4x-UltraSharp') patch({ ...ANIMA_HIRES_PRESET })
    else patch({ hiresFix: true, hiresUpscaler: value })
  },
})
const comfyHiresPath = computed(() => {
  if (hiresUpscaler.value === '4x-UltraSharp') return 'refine'
  if (hiresUpscaler.value === 'Latent') return 'latent'
  if (hiresUpscaler.value === 'Remacri') return 'pixel'
  if (props.state.autoHiresModel === undefined) return 'unknown'
  return props.state.autoHiresModel ? 'pixel' : 'latent'
})
const hiresModes = computed(() => [
  { value: '', label: '关闭' },
  { value: '4x-UltraSharp', label: 'UltraSharp · 放大后重绘', disabled: native.value && !selectedModel.value?.capabilities?.hiresUpscalers?.includes('4x-UltraSharp') },
  { value: 'Remacri', label: 'Remacri · 纯放大', disabled: native.value && !selectedModel.value?.capabilities?.hiresUpscalers?.includes('Remacri') },
  { value: 'Auto', label: '自动' }, { value: 'Latent', label: 'Latent · 二次重绘' },
])
const busy = computed(() => ['submitting', 'running', 'cancelling'].includes(props.state.phase))
const outputSize = computed(() => {
  const scale = props.state.hiresFix ? (props.state.hiresScale ?? 1.5) : 1
  return `${Math.round(props.state.width * scale / 8) * 8} × ${Math.round(props.state.height * scale / 8) * 8}`
})
const selectedModel = computed(() => props.state.models.find(model => model.id === props.state.modelId) ?? null)
const selectedLora = computed(() => props.state.loras.find(lora => lora.id === props.state.loraId) ?? null)
/** 当前底模能力表：引擎默认值 + 后端模型能力合并（UI 不再按 family 散落判断）。 */
const capabilities = computed(() => resolveDrawCapabilities(props.state.family, null, selectedModel.value?.capabilities ?? null))
const nativeAnima = computed(() => native.value && props.state.family === 'anima')
const fixedSampling = computed(() => selectedModel.value?.capabilities?.fixedSampling ?? false)
/** 热门角色无 LoRA：只在 popular subject + noLora capability 时隐藏 LoRA 选择。 */
const noLoraMode = computed(() => props.noLora === true && selectedModel.value?.capabilities?.noLora === true)
function randomSeed() { patch({ seed: Math.floor(Math.random() * 1_000_000_000) }) }
</script>

<template>
  <section class="panel step-panel anima-quick-panel" aria-label="引擎采样参数">
    <div class="anima-body">
       <RouterLink v-if="state.family === 'krea2' && !state.online" class="btn btn-ghost anima-setup-link" :to="{ path: '/control', query: { engine: 'krea2' } }">查看 Krea 环境与准备范围</RouterLink>
       <p v-if="capabilities.promptFormat === 'natural-language'" class="anima-preview-note tw:m-0 tw:text-warning-text tw:text-label-xs tw:leading-label"><strong>Krea 2</strong> · 自然语言生成，无角色 LoRA</p>
        <p v-else-if="selectedLora?.preview" class="anima-preview-note tw:m-0 tw:text-warning-text tw:text-label-xs tw:leading-label"><strong>实验预览</strong> · 此 LoRA 为实验版</p>

       <div v-if="capabilities.lora && !noLoraMode && !studioLoraDisabled" class="anima-field anima-lora-fields">
        <div class="anima-form-field">
          <label :for="idOf('lora')">LoRA</label>
          <StudioSelect :id="idOf('lora')" v-model="loraId" label="LoRA" :disabled="busy"
            :options="state.loras.map(l => ({ value: l.id, label: l.name || l.id }))" />
        </div>
        <div class="anima-form-field">
          <label :for="idOf('strength')">强度</label>
          <input :id="idOf('strength')" v-model.number="loraStrength" type="number" min="0.65" max="1" step="0.05" class="input input-sm anima-num" :disabled="busy" />
        </div>
       </div>
       <template v-if="state.family === 'krea2'">
         <div class="anima-field">
           <label :for="idOf('recipe')">画风配方</label>
           <StudioSelect :id="idOf('recipe')" v-model="styleRecipeId" label="画风配方" :options="recipeOptions" :disabled="busy" />
         </div>
         <div v-if="styleOptions.length" class="anima-field">
           <label :for="idOf('style')">风格 LoRA</label>
           <StudioSelect :id="idOf('style')" v-model="styleLoraId" label="风格 LoRA" :disabled="busy"
             :options="[{ value: '', label: '不使用风格 LoRA' }, ...styleOptions]" />
           <span v-if="!styleLoraId" class="anima-field-hint">本地风格文件放入 LoRA 目录下的 <code>krea2/</code>，可附同名 <code>.json</code> 设置中文名、触发词与推荐强度。</span>
           <template v-if="styleLoraId">
             <StudioSlider v-model="styleLoraStrength" label="风格强度" :min="-2" :max="2" :step="0.05" compact :disabled="busy" />
             <label :for="idOf('second-style')">叠加 LoRA</label>
             <StudioSelect :id="idOf('second-style')" v-model="secondaryStyleLoraId" label="叠加 LoRA" :disabled="busy"
               :options="[{ value: '', label: '不叠加' }, ...styleOptions.filter(option => option.value !== styleLoraId)]" />
             <StudioSlider v-if="secondaryStyleLoraId" v-model="secondaryStyleLoraStrength" label="叠加强度" :min="-2" :max="2" :step="0.05" compact :disabled="busy" />
           </template>
         </div>
       </template>
      <div class="anima-parameter-grid">
        <div class="anima-field anima-seed-field">
          <label :for="idOf('seed')">随机种子</label>
          <div class="anima-seed-control">
            <input :id="idOf('seed')" v-model.number="seed" type="number" min="0" step="1" placeholder="随机" class="input input-sm anima-num" :disabled="busy" spellcheck="false" autocorrect="off" />
            <StudioTooltip content="生成随机种子" anchor><button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="生成随机种子" :disabled="busy" @click="randomSeed"><ArchiveIcon name="refresh" /></button></StudioTooltip>
          </div>
        </div>
        <div class="anima-field anima-field--slider">
          <label :for="idOf('steps')">采样步数</label>
          <StudioSlider v-model="steps" :min="1" :max="60" :step="1" compact :show-value="false"
            class="anima-slider" aria-label="采样步数滑块" :disabled="busy || fixedSampling" />
          <input :id="idOf('steps')" v-model.number="steps" type="number" min="1" max="60" class="input input-sm anima-num" :disabled="busy || fixedSampling" />
        </div>
        <div class="anima-field anima-field--slider">
          <label :for="idOf('cfg')">引导强度 <small>CFG</small></label>
          <StudioSlider v-model="cfg" :min="state.family === 'krea2' ? 0 : 0.5" :max="10" :step="0.5" compact :show-value="false"
            class="anima-slider" aria-label="引导强度滑块" :disabled="busy || fixedSampling" />
          <input :id="idOf('cfg')" v-model.number="cfg" type="number" :min="state.family === 'krea2' ? 0 : 0.5" max="10" step="0.5" class="input input-sm anima-num" :disabled="busy || fixedSampling" />
        </div>
      </div>

      <!-- 加速与高清修复控制（由能力表驱动，当前仅 Anima 开启） -->
      <div v-if="nativeAnima || capabilities.hires || capabilities.teaCache || hiresFix || teaCache" class="anima-hires-options">
        <ToggleSwitch v-model="teaCache" :disabled="busy || (!capabilities.teaCache && !teaCache)" label="TeaCache 特征缓存加速" class="anima-hires-toggle">
          <ArchiveIcon name="lightning" class="anima-hires-icon" />
          <span>特征缓存 <small>TeaCache</small></span>
        </ToggleSwitch>
        <div v-if="(nativeAnima || capabilities.teaCache) && teaCache" class="anima-field anima-field--slider">
          <label :for="idOf('cache-threshold')">缓存阈值</label>
          <StudioSlider :model-value="cacheThreshold" :min="0" :max="0.25" :step="0.01" compact :show-value="false" class="anima-slider" aria-label="TeaCache 缓存阈值滑块" :aria-describedby="idOf('cache-threshold-hint')" :disabled="busy" @update:model-value="patch({ teaCacheThresh: $event })" />
          <input :id="idOf('cache-threshold')" type="number" min="0" max="0.25" step="0.01" :value="cacheThreshold" class="input input-sm anima-num" :disabled="busy" :aria-describedby="idOf('cache-threshold-hint')" @change="updateCacheThreshold" />
          <span :id="idOf('cache-threshold-hint')" class="anima-field-hint">0–0.25 · 默认 0.10</span>
        </div>
        <div v-if="nativeAnima || capabilities.hires || hiresFix" class="anima-parameter-grid">
          <div class="anima-field anima-form-field">
            <label :for="idOf('upscaler')">出图时高清放大</label>
            <StudioSelect :id="idOf('upscaler')" v-model="hiresMode" label="出图时高清放大" :disabled="busy || (!(native ? selectedModel?.capabilities?.hires === true : capabilities.hires) && !hiresFix)" :options="hiresModes" />
          </div>
          <div v-if="hiresFix" class="anima-field anima-form-field">
            <label :for="idOf('scale')">倍率</label>
            <StudioSelect :id="idOf('scale')" v-model.number="hiresScale" label="倍率" :disabled="busy"
              :options="[{ value: 1.5, label: '1.5×' }, { value: 2.0, label: '2.0×' }]" />
          </div>
          <template v-if="hiresFix && hiresUpscaler !== 'Remacri'">
            <div class="anima-field anima-form-field">
              <label :for="idOf('denoise')">二次重绘幅度</label>
              <input :id="idOf('denoise')" v-model.number="hiresDenoise" type="number" min="0.1" max="1" step="0.05" class="input input-sm anima-num" :disabled="busy || (!native && comfyHiresPath === 'pixel')" />
            </div>
            <div class="anima-field anima-form-field">
              <label :for="idOf('hires-steps')">高清采样步数</label>
              <input :id="idOf('hires-steps')" v-model.number="hiresSteps" type="number" min="1" max="60" step="1" class="input input-sm anima-num" :disabled="busy || hiresUpscaler === 'Auto'" />
            </div>
            <div class="anima-field anima-form-field">
              <label :for="idOf('hires-cfg')">高清引导强度 CFG</label>
              <input :id="idOf('hires-cfg')" v-model.number="hiresCfg" type="number" min="0.5" max="10" step="0.5" class="input input-sm anima-num" :disabled="busy || hiresUpscaler === 'Auto'" />
            </div>
          </template>
        </div>
      </div>
      <p v-if="hiresFix" class="anima-output-note"><span>最终画幅</span><output>{{ outputSize }}</output></p>
      <p v-if="!native && hiresFix" class="anima-hint tw:text-label-xs tw:text-secondary tw:m-0">
        <template v-if="comfyHiresPath === 'refine'">UltraSharp 放大后重绘 · Euler / Normal · Shift 3</template>
        <template v-else-if="comfyHiresPath === 'unknown'">路径待确认，请刷新状态。</template>
        <template v-else-if="comfyHiresPath === 'pixel'">像素放大{{ hiresUpscaler === 'Auto' && state.autoHiresModel ? `（${state.autoHiresModel}）` : '' }}，重绘幅度不生效。</template>
        <template v-else>Latent 二次重绘生效中。</template>
      </p>
      <p v-if="native && hiresFix && hiresUpscaler === '4x-UltraSharp'" class="anima-hint tw:text-label-xs tw:text-secondary tw:m-0">UltraSharp 放大后重绘 · Euler / Normal · Shift 3</p>
      <p v-if="native && hiresFix && hiresUpscaler === 'Auto'" class="anima-hint tw:text-label-xs tw:text-secondary tw:m-0">优先使用 Remacri 纯放大，缺少权重时使用 Latent 重绘。</p>
      <RouterLink v-if="hiresFix && hiresUpscaler === '4x-UltraSharp' && (!native || !selectedModel?.capabilities?.hiresUpscalers?.includes('4x-UltraSharp'))" class="btn btn-quiet btn-sm" :to="{ path: '/control', query: { resource: 'ultrasharp-4x' }, hash: '#control-setup' }">准备 UltraSharp 高清放大</RouterLink>
      <RouterLink v-if="native && hiresFix && (hiresUpscaler === 'Auto' || hiresUpscaler === 'Remacri') && !selectedModel?.capabilities?.hiresUpscalers?.includes('Remacri')" class="btn btn-quiet btn-sm" :to="{ path: '/control', query: { resource: 'remacri-4x' }, hash: '#control-setup' }">准备 Remacri 高清放大</RouterLink>

      <details class="anima-prompt-details"><StudioDisclosureSummary>查看底层提示词</StudioDisclosureSummary><div data-disclosure-content>
      <label :for="idOf('prompt')" class="anima-label">正向提示词</label>
      <textarea :id="idOf('prompt')" :value="state.prompt" rows="4" class="input anima-textarea" readonly spellcheck="false" autocorrect="off"></textarea>

       <template v-if="capabilities.negative">
         <label :for="idOf('negative')" class="anima-label">负向提示词</label>
         <textarea :id="idOf('negative')" :value="state.negative" rows="2" class="input anima-textarea" readonly spellcheck="false" autocorrect="off"></textarea>
       </template>

      </div></details>
    </div>
  </section>
</template>

<style scoped>
.anima-quick-panel { min-width:0; margin:0; }
.anima-body { display:grid; gap:var(--s-3); min-width:0; container-type:inline-size; }
.anima-setup-link { justify-self:start; white-space:normal; text-align:left; }
/* Fields share one reading plane; the shared input styles own control geometry. */
.anima-parameter-grid { display:grid; gap:var(--s-3); min-width:0; }
.anima-field { display:grid; align-items:center; gap:var(--s-2); min-width:0; }
.anima-field--slider { grid-template-columns:minmax(5.5rem,max-content) minmax(48px,1fr) 4rem; }
.anima-field-hint { grid-column:1 / -1; color:var(--text-secondary); font-size:var(--fs-label-xs); line-height:var(--lh-label); }
.anima-form-field { display:grid; align-content:start; gap:var(--s-2); min-width:0; }
.anima-lora-fields { grid-template-columns:minmax(0,1fr) minmax(0,5rem); }
.anima-field label,.anima-label { color:var(--text-secondary); font-size:var(--fs-label); line-height:var(--lh-label); }
.anima-field label small,.anima-hires-toggle small { color:var(--text-muted); font-size:var(--fs-label-xs); }
.anima-field .studio-select-wrapper { width:100%; min-width:0; }
.anima-num,.anima-textarea { width:100%; min-width:0; font-variant-numeric:tabular-nums; }
.anima-slider { width:100%; }
.anima-seed-field { grid-template-columns:5.5rem minmax(0,1fr); }
.anima-seed-control { display:flex; gap:var(--s-2); min-width:0; }
.anima-seed-control .anima-num { flex:1; width:0; font-family:var(--font-mono); }
.anima-seed-control .btn { flex:none; }
.anima-output-note { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:var(--s-2); margin:0; color:var(--text-secondary); font-size:var(--fs-label-xs); font-variant-numeric:tabular-nums; }
.anima-output-note output { color:var(--text-primary); }
.anima-hires-icon { flex:none; width:16px; height:16px; color:var(--accent); }
.anima-hires-options { display:grid; gap:var(--s-2); min-width:0; padding-top:var(--s-3); border-top:1px solid var(--border-soft); }
.anima-hires-toggle { width:100%; min-width:0; color:var(--text-secondary); font:400 var(--fs-label)/var(--lh-label) var(--font-sans); }
.anima-hires-toggle > span:last-child { flex:1; min-width:0; overflow-wrap:anywhere; }
.anima-label { display:block; margin:var(--s-2) 0; }
.anima-textarea { font-family:var(--font-mono); }
.anima-prompt-details { color:var(--text-muted); font-size:var(--fs-label-xs); }
.anima-prompt-details summary { padding-block:var(--s-2); color:var(--text-secondary); font-size:var(--fs-label); cursor:pointer; }
.anima-prompt-details textarea { margin-block:var(--s-2); }
.anima-quick-panel summary:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
/* Below a narrow rail's usable width, keep a readable slider on its own row. */
@container (max-width:220px) {
  .anima-field--slider { grid-template-columns:minmax(0,1fr) 4.25rem; }
  .anima-field--slider .anima-num { grid-column:2; grid-row:1; }
  .anima-field--slider .anima-slider { grid-column:1 / -1; grid-row:2; }
}
</style>
