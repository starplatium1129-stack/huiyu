<template>
  <!-- 桌面常驻侧栏；窄窗口与专注模式紧随画布，保留尺寸、生成与停止。 -->
  <div class="gen-bar" :class="{ 'is-generating': busy }" role="group" aria-label="出图尺寸与生成">
    <label class="gen-bar-size">
      <ArchiveIcon name="centercomp" class="gen-bar-aspect-icon" aria-hidden="true" />
      <span class="gen-bar-label">画幅</span>
      <StudioSelect
        size="sm"
        label="画幅比例"
        :model-value="size"
        :disabled="busy"
        :groups="engine === 'sd' ? sizeGroups : undefined"
        :options="engine === 'sd' ? undefined : sizeOptions"
        @update:model-value="onSizeChange"
      />
    </label>
    <span v-if="presetSummary" class="gen-bar-preset">{{ presetSummary }}</span>
    <!--
      提交前校验（2026-08-30 UX 审计 P1）：原先点下去才在 2.5 秒的闪示里被告知
      「请先选择场景或填写故事」，用户根本来不及读。原因改成常驻在按钮旁，
      同时禁用按钮——既要看得见，也不要让人点了才发现不行。
    -->
    <span v-if="unavailableReason && !busy" class="gen-bar-blocked" role="status">{{ unavailableReason }}</span>
    <div class="gen-bar-actions">
      <StudioTooltip anchor :content="busy ? '停止当前绘制' : unavailableReason || '生成当前画面'">
        <button
          ref="generationAction"
          :data-testid="engine === 'sd' ? 'sd-generate' : 'anima-generate'"
          class="btn generation-action"
          :class="[busy ? 'btn-ghost' : 'btn-primary', { 'is-drawing': busy }]"
          type="button"
          :aria-label="busy ? '停止绘制' : '生成图片'"
          :disabled="!busy && (!online || !!blockedReason)"
          @click="busy ? $emit('cancel') : $emit('generate')"
        >
          <span class="generation-action-surface" aria-hidden="true" />
          <span class="generation-action-content">
            <span class="generation-action-label"><ArchiveIcon :name="busy ? 'close' : 'spark'" aria-hidden="true" /><span v-content-motion="busy">{{ busy ? '停止绘制' : '生成图片' }}</span></span>
            <strong v-if="busy && progressValue !== null" class="generation-percent" aria-hidden="true">{{ progressValue }}%</strong>
            <span v-if="busy" class="generation-track" :class="{ 'is-indeterminate': progressValue === null }" role="progressbar" aria-label="当前绘制进度" :aria-valuenow="progressValue ?? undefined" aria-valuemin="0" aria-valuemax="100"><i :style="{ '--generation-progress': progressValue === null ? 1 : progressValue / 100 }" /></span>
          </span>
        </button>
      </StudioTooltip>
      <StudioTooltip anchor content="清除当前画布图片，已入册的作品不受影响">
        <button class="btn btn-ghost" type="button" :disabled="!hasResult" @click="$emit('clearResult')">清除图片</button>
      </StudioTooltip>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useEventListener } from '@vueuse/core'
import { contentMotion as vContentMotion } from '@/directives/contentMotion'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import type { StudioSelectGroup } from '@/components/ui/StudioSelect.vue'
import type { DrawEngine } from '@/storage/settingsRepository'
// 出图条承载主行动（生成按钮），同步导入保证首屏即位，不进异步分片；
// 体量 ~2KB，路由 CSS 预算余量充足。
import '@/assets/css/director/components/GenerationActionBar.css'

const props = defineProps<{
  engine: DrawEngine
  busy: boolean
  progress?: number | null
  online: boolean
  /** 当前生效尺寸：SD 取 sdSize，Anima/Krea2 取 width×height（宿主统一收敛）。 */
  size: string
  /** Anima/Krea2 候选尺寸（当前底模白名单，含当前值兜底）。 */
  animaSizes: string[]
  presetSummary: string
  hasResult: boolean
  /**
   * 提交前校验的原因（2026-08-30 UX 审计 P1）。非空即禁用生成按钮，并把原因
   * 常驻在按钮旁。
   *
   * 之所以用「原因字符串」而不是布尔量：禁用一个按钮却不说是为什么，用户只会
   * 以为软件坏了。宿主算原因、本组件只负责展示，校验规则因此只有一处。
   */
  blockedReason?: string
}>()

const unavailableReason = computed(() => props.blockedReason || (!props.online ? '绘图服务未连接，请先在控制面板启动并检查连接。' : ''))
const progressValue = computed(() => typeof props.progress === 'number' && Number.isFinite(props.progress)
  ? Math.round(Math.max(0, Math.min(1, props.progress)) * 100) : null)
const generationAction = ref<HTMLButtonElement | null>(null)
let captureMorph: typeof import('@/utils/generationControlMorph')['captureGenerationMorph'] | undefined
let cancelMorph: typeof import('@/utils/generationControlMorph')['cancelGenerationMorph'] | undefined
void import('@/utils/generationControlMorph').then(module => { captureMorph = module.captureGenerationMorph; cancelMorph = module.cancelGenerationMorph })
watch(() => props.busy, () => { const finish = captureMorph?.(generationAction.value); if (finish) void nextTick(finish) })
const settleMorph = () => cancelMorph?.(generationAction.value)
useEventListener(document, 'visibilitychange', () => { if (document.hidden) settleMorph() })
useEventListener(window, 'atelier:motion-preference', settleMorph)
useEventListener(window.matchMedia('(prefers-reduced-motion: reduce)'), 'change', settleMorph)
onBeforeUnmount(settleMorph)

const emit = defineEmits<{
  'update:size': [value: string]
  generate: []
  cancel: []
  clearResult: []
}>()

// SD 引擎按竖/方/横/官方 CG 分组；Anima/Krea2 取平铺候选尺寸。
const sizeGroups: StudioSelectGroup[] = [
  { label: '竖图 Portrait', options: [
    { value: '768x1344', label: '768×1344' },
    { value: '832x1216', label: '832×1216' },
    { value: '896x1344', label: '896×1344' },
    { value: '1024x1344', label: '1024×1344 · WAI 推荐' },
    { value: '1024x1536', label: '1024×1536' },
    { value: '1152x1536', label: '1152×1536' },
  ] },
  { label: '方图 Square', options: [
    { value: '896x896', label: '896×896' },
    { value: '1024x1024', label: '1024×1024' },
    { value: '1280x1280', label: '1280×1280' },
  ] },
  { label: '横图 Landscape', options: [
    { value: '1216x832', label: '1216×832' },
    { value: '1344x896', label: '1344×896' },
    { value: '1536x1024', label: '1536×1024' },
  ] },
  { label: '16:9 官方 CG', options: [
    { value: '1344x768', label: '1344×768' },
  ] },
]
const sizeOptions = computed(() =>
  props.animaSizes.map(item => ({ value: item, label: item.replace('x', '×') })),
)

function onSizeChange(value: string | number) {
  if (value !== '' && value != null) emit('update:size', String(value))
}
</script>

<style scoped>
.generation-track:not(.is-indeterminate) i { transform:scaleX(var(--generation-progress,0)); }
</style>
