<template>
  <details class="panel generation-settings">
    <summary class="panel-title settings-summary">
      出图参数
      <!--
        恢复默认（2026-08-30 UX 审计 P1）：调参调乱了没有回头路。必须 .stop
        挡住冒泡——summary 的点击会折叠整块面板，不挡就是「一按就收起来」。
      -->
      <button type="button" class="btn btn-ghost btn-mini params-reset"
        title="把 CFG / Steps / 采样器等恢复为当前底模的推荐值"
        @click.stop.prevent="$emit('reset')">恢复默认</button>
    </summary>
    <div class="controls-grid">
      <div class="ctrl"><label :for="idOf('cfg')">相关性 (CFG)</label>
        <input :id="idOf('cfg')" v-model.number="params.cfg" class="input ctrl-num" type="number"
          min="1" max="20" step="0.5" :list="idOf('cfg-presets')"
          title="提示词遵循强度：值越高越贴近提示词，过低画面会漂。常用 5–8，也可直接输入任意值。"
          @change="normalize('cfg', 7, 1, 20)">
        <datalist :id="idOf('cfg-presets')">
          <option v-for="v in CFG_PRESETS" :key="v" :value="v"></option>
        </datalist>
      </div>
      <div class="ctrl"><label :for="idOf('steps')">步数 (Steps)</label>
        <input :id="idOf('steps')" v-model.number="params.steps" class="input ctrl-num" type="number"
          min="1" max="150" step="1" :list="idOf('steps-presets')"
          title="采样步数：越多细节越足、耗时越长，常用 20-40，也可直接输入任意值。"
          @change="normalize('steps', 28, 1, 150)">
        <datalist :id="idOf('steps-presets')">
          <option v-for="v in STEPS_PRESETS" :key="v" :value="v"></option>
        </datalist>
      </div>
      <div class="ctrl"><label :for="idOf('sampler')">采样器 (Sampler)</label>
        <select :id="idOf('sampler')" v-model="params.sampler" title="采样器：决定去噪方式与画面质感。" @change="touch('sampler')">
          <option v-for="sampler in samplerOptions" :key="sampler">{{ sampler }}</option>
        </select>
      </div>
      <div class="ctrl"><label :for="idOf('scheduler')">调度器 (Scheduler)</label>
        <select :id="idOf('scheduler')" v-model="params.scheduler" title="调度器：配合采样器控制去噪节奏，一般保持自动。" @change="touch('scheduler')">
          <option value="">自动</option>
          <option v-for="scheduler in schedulerOptions" :key="scheduler">{{ scheduler }}</option>
        </select>
      </div>
      <div class="ctrl toggle-row">
        <ToggleSwitch v-model="params.quality" label="质量前缀" />
        <label title="由模型 profile 注入的质量前缀，无需手写。">质量前缀</label>
      </div>
      <div class="ctrl toggle-row">
        <ToggleSwitch v-model="params.negative" label="负面提示词" />
        <label title="启用负面提示词，防止常见画面缺陷与多余元素。">负面提示词</label>
      </div>
      <div class="ctrl ctrl-seed">
        <ToggleSwitch v-model="params.seedLock" class="seed-lock-label" label="固定随机种子 (Seed)"><span>固定随机种子 (Seed)</span></ToggleSwitch>
        <div class="seed-input-wrap">
          <input type="number" v-model.number="params.seed" min="-1" step="1" placeholder="-1"
            aria-label="Seed，填 -1 表示随机">
          <button class="btn btn-ghost btn-mini" type="button" :disabled="resultSeed == null" @click="$emit('reuse-seed')">复用</button>
        </div>
        <small class="ctrl-hint">{{ params.seedLock ? '锁定后复用当前固定 Seed' : '未锁定时每次随机生成 Seed' }}</small>
      </div>
      <div v-if="params.negative" class="ctrl ctrl-full negative-editor">
        <label :for="idOf('negative')">负面提示词</label>
        <textarea :id="idOf('negative')" v-model="params.negativeCustom" title="留空使用默认负面；可追加常见缺陷词，如 extra fingers, bad anatomy。" placeholder="留空使用默认负面；可追加如：extra fingers, bad anatomy"></textarea>
      </div>
    </div>
  </details>
</template>

<script setup lang="ts">
import { computed, useId } from 'vue'
import ToggleSwitch from '@/components/visual/ToggleSwitch.vue'
import type { SDParams } from '@/utils/promptBuilderPersistence'
import '@/assets/css/director/components/GenerationParamsPanel.css'

const props = defineProps<{
  samplers: readonly string[]
  schedulers: readonly string[]
  resultSeed: number | null
}>()

// params 由 Pinia store 的 reactive 对象承载，子组件按契约直接改字段；
// 用 defineModel 承载该双向约定（替代裸 prop 深层变更）。
const params = defineModel<SDParams>('params', { required: true })

const emit = defineEmits<{
  touch: [key: keyof SDParams]
  'reuse-seed': []
  /** 恢复底模推荐参数：默认值只有 store 知道（按 checkpoint 匹配 profile）。 */
  reset: []
}>()

/**
 * 标签关联 id（与 AnimaQuickPanel 同口径）：用 useId 而非硬编码，本面板随
 * defineAsyncComponent 懒加载且可能多实例，硬编码 id 重复会让标签指错控件。
 */
const uid = useId()
function idOf(field: string) { return `${uid}-${field}` }

/**
 * CFG / Steps 的常用档位（2026-08-30 UX 审计 P1）。
 *
 * 原先只有 8 档 / 6 档下拉，想跑 CFG 6.5 做 A/B 对比根本做不到，而同项目的
 * AnimaQuickPanel 早就是 number + min/max/step，两条路体验割裂。改成自由输入后
 * 这些档位降级为 datalist 建议——「挑一个就行」的便利保留，精确调参也做得到。
 */
const CFG_PRESETS = [3, 4, 4.5, 5, 5.5, 6, 7, 8]
const STEPS_PRESETS = [20, 28, 30, 35, 40, 50]

const samplerOptions = computed(() =>
  props.samplers.length ? props.samplers : ['Euler a', 'Euler', 'DPM++ 2M', 'DPM++ 2M SDE'],
)
const schedulerOptions = computed(() =>
  props.schedulers.length ? props.schedulers : ['Karras', 'Exponential'],
)
function touch(key: keyof SDParams) { emit('touch', key) }

/**
 * 数字框的取值收口。
 *
 * 自由输入的代价是用户能把它清空、填上 0 或 999——select 时代这些值根本
 * 输不进去。这里夹回合法区间，非法（空 / NaN）回退到常用值，不让 NaN 顺着
 * 出图请求流到后端。区间与模板里的 min/max 保持一致。
 */
function normalize(key: 'cfg' | 'steps', fallback: number, min: number, max: number) {
  const raw = params.value[key]
  const parsed = typeof raw === 'number' ? raw : Number(raw)
  const next = Number.isFinite(parsed) && parsed !== 0 ? parsed : fallback
  params.value[key] = Math.min(max, Math.max(min, next))
  touch(key)
}
</script>
