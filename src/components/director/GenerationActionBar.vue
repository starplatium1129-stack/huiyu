<template>
  <!-- 桌面常驻侧栏；窄窗口独立吸附于整个编辑区，保留尺寸、生成与停止。 -->
  <div class="gen-bar" :class="{ 'is-generating': busy }" role="group" aria-label="出图尺寸与生成">
    <GenerationSizePicker v-if="showSize" class="gen-bar-size" compact v-bind="{ engine, size, animaSizes, busy }" @update:size="$emit('update:size', $event)" />
    <div class="gen-bar-meta" role="status"><span><ArchiveIcon :name="busy ? 'spark' : error || !online ? 'warning' : 'success'" />{{ busy ? '正在绘制' : error ? '绘制未完成' : stopped ? '已停止' : !online ? '绘图服务未连接' : '准备就绪' }}</span><small>{{ size.replace('x', ' × ') }}</small></div>
    <!--
      提交前校验（2026-08-30 UX 审计 P1）：原先点下去才在 2.5 秒的闪示里被告知
      「请先选择场景或填写故事」，用户根本来不及读。原因改成常驻在按钮旁，
      同时禁用按钮——既要看得见，也不要让人点了才发现不行。
    -->
    <RouterLink v-if="!online && !busy" class="gen-bar-recovery" :to="{ path: '/control', query: { engine } }">{{ unavailableReason }}</RouterLink>
    <span v-else-if="blockedReason && !busy" class="gen-bar-blocked" role="status">{{ blockedReason }}</span>
    <div class="gen-bar-actions">
      <StudioTooltip anchor :content="busy ? '停止当前绘制' : unavailableReason || '生成当前画面'">
        <button
          ref="generationAction"
          :data-testid="engine === 'sd' ? 'sd-generate' : 'anima-generate'"
          class="btn generation-action"
          :class="[status === 'idle' ? 'btn-primary' : 'btn-ghost', { 'is-drawing': busy }]"
          :data-state="status"
          type="button"
          :aria-label="actionLabel"
          :disabled="!busy && (!online || !!blockedReason)"
          @click="busy ? $emit('cancel') : $emit('generate')"
        >
          <span class="generation-action-surface" aria-hidden="true" />
          <span class="generation-action-content">
            <span class="generation-action-label"><ArchiveIcon :name="actionIcon" aria-hidden="true" /><span v-content-motion="status">{{ actionText }}</span></span>
            <strong v-if="busy && progressValue !== null" class="generation-percent" aria-hidden="true">{{ progressValue }}%</strong>
            <span v-if="busy" class="generation-track" :class="{ 'is-indeterminate': progressValue === null }" role="progressbar" aria-label="当前绘制进度" :aria-valuenow="progressValue ?? undefined" aria-valuemin="0" aria-valuemax="100"><i :style="{ '--generation-progress': progressValue === null ? 1 : progressValue / 100 }" /></span>
          </span>
        </button>
      </StudioTooltip>

    </div>
    <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">{{ announcement }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useEventListener } from '@vueuse/core'
import { contentMotion as vContentMotion } from '@/directives/contentMotion'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import GenerationSizePicker from './GenerationSizePicker.vue'
import { RouterLink } from 'vue-router'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
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
  showSize: boolean
  hasResult: boolean
  /** Completion comes from the task phase, never the presence of an older image. */
  completed?: boolean
  statusText?: string
  error?: string
  stopped?: boolean
  /**
   * 提交前校验的原因（2026-08-30 UX 审计 P1）。非空即禁用生成按钮，并把原因
   * 常驻在按钮旁。
   *
   * 之所以用「原因字符串」而不是布尔量：禁用一个按钮却不说是为什么，用户只会
   * 以为软件坏了。宿主算原因、本组件只负责展示，校验规则因此只有一处。
   */
  blockedReason?: string
}>()

const status = computed(() => props.busy ? 'loading' : props.error ? 'error'
  // Restoring an older result also uses succeeded; only the generation receipt
  // (legacy or runtime inbox variant) announces a newly completed drawing.
  : props.completed && props.hasResult && !props.stopped && props.statusText?.startsWith('生成完成') ? 'success' : 'idle')
const actionText = computed(() => ({ idle: '生成图片', loading: '停止绘制', success: '完成 · 再生成', error: '重试生成' })[status.value])
const actionLabel = computed(() => status.value === 'success' ? '生成完成，再生成图片' : actionText.value)
const actionIcon = computed(() => ({ idle: 'spark', loading: 'close', success: 'success', error: 'refresh' } as const)[status.value])
const announcement = computed(() => props.busy ? '正在绘制，可随时停止。' : props.stopped ? '绘制已停止。'
  : status.value === 'error' ? `生成失败：${props.error}` : status.value === 'success' ? '生成完成，可以查看画布或再次生成。' : '')
const unavailableReason = computed(() => props.blockedReason || (!props.online ? '绘图服务未连接，请先在控制面板启动并检查连接。' : ''))
const progressValue = computed(() => typeof props.progress === 'number' && Number.isFinite(props.progress)
  ? Math.round(Math.max(0, Math.min(1, props.progress)) * 100) : null)
const generationAction = ref<HTMLButtonElement | null>(null)
let captureMorph: typeof import('@/utils/generationControlMorph')['captureGenerationMorph'] | undefined
let cancelMorph: typeof import('@/utils/generationControlMorph')['cancelGenerationMorph'] | undefined
void import('@/utils/generationControlMorph').then(module => { captureMorph = module.captureGenerationMorph; cancelMorph = module.cancelGenerationMorph })
watch(status, () => { const finish = captureMorph?.(generationAction.value); if (finish) void nextTick(finish) })
const settleMorph = () => cancelMorph?.(generationAction.value)
useEventListener(document, 'visibilitychange', () => { if (document.hidden) settleMorph() })
useEventListener(window, 'atelier:motion-preference', settleMorph)
useEventListener(window.matchMedia('(prefers-reduced-motion: reduce)'), 'change', settleMorph)
onBeforeUnmount(settleMorph)

defineEmits<{
  'update:size': [value: string]
  generate: []
  cancel: []
}>()

</script>

<style scoped>
.generation-track:not(.is-indeterminate) i { transform:scaleX(var(--generation-progress,0)); }
</style>
