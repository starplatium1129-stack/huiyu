<template>
  <!-- 桌面常驻侧栏；窄窗口独立吸附于整个编辑区，保留尺寸、生成与停止。 -->
  <div ref="generationBar" class="gen-bar" :data-docked="docked || undefined" role="group" aria-label="出图尺寸与生成">
    <GenerationSizePicker v-if="showSize" class="gen-bar-size" compact v-bind="{ engine, size, animaSizes, busy }" @update:size="$emit('update:size', $event)" />
    <div class="gen-bar-meta">
      <div class="gen-bar-status">
        <span role="status"><ArchiveIcon :name="busy ? 'spark' : error || !online || blockedReason || presentation.needsReview ? 'warning' : 'success'" />{{ statusSummary }}</span>
        <button v-if="presentation.phase === 'cancelling'" class="btn btn-quiet gen-bar-recovery" type="button" @click="openGenerationTasks">查看任务</button>
        <button v-if="presentation.needsReview" class="btn btn-quiet gen-bar-recovery" type="button" @click="$emit('cancel')">取消原请求</button>
        <RouterLink v-if="!online && !busy" class="gen-bar-recovery" :to="{ path: '/control', query: { engine } }" aria-label="检查绘图配置">检查配置</RouterLink>
        <RouterLink v-else-if="missingCharacter && !busy" class="gen-bar-recovery" :to="{ path: '/control', hash: '#control-image-resources' }">准备角色包</RouterLink>
      </div>
      <small v-if="!showSize">{{ size.replace('x', ' × ') }}</small>
    </div>
    <!-- 输入校验原因仍常显；离线原因已与恢复入口合并，不重复占一行。 -->
    <span v-if="online && blockedReason && !busy" class="gen-bar-blocked" role="status">{{ blockedReason }}</span>
    <div class="gen-bar-actions">
      <StudioTooltip :anchor="!busy" :content="presentation.needsReview ? '核对现有任务与已保存结果' : busy ? presentation.phase === 'cancelling' ? presentation.message : '停止当前绘制' : unavailableReason || (connected === false ? readinessText : '') || '生成当前画面'">
        <button
          ref="generationAction"
          :data-testid="engine === 'sd' ? 'sd-generate' : 'anima-generate'"
          class="btn btn-ghost generation-action studio-press-ripple"
          :class="{ 'is-drawing': busy }"
          :data-state="status"
          type="button"
          :aria-label="actionLabel"
          :aria-disabled="cancellationPending || undefined"
          :aria-busy="cancellationPending || undefined"
          :disabled="!busy && !presentation.needsReview && (!online || !!blockedReason)"
          @click.capture="pressRipple"
          @click="activate"
        >
          <span class="generation-action-surface" aria-hidden="true" />
          <span class="generation-action-content">
            <span class="generation-action-label"><ArchiveIcon :name="actionIcon" aria-hidden="true" /><span v-content-motion="actionText">{{ actionText }}</span></span>
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
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, ref, watch } from 'vue'
import { useResizeObserver, useEventListener } from '@vueuse/core'
import { contentMotion as vContentMotion } from '@/directives/contentMotion'
import { usePressRipple } from '@/composables/usePressRipple'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import GenerationSizePicker from './GenerationSizePicker.vue'
import { RouterLink } from 'vue-router'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import type { DrawEngine } from '@/storage/settingsRepository'
import { openGenerationTasks, type GenerationPresentation } from '@/composables/prompt/useGenerationPresentation'
// 主行动同步加载；组件统一管理停靠与独立两种内部布局。
import '@/assets/css/director/components/GenerationActionBar.css'

const props = defineProps<{
  engine: DrawEngine
  busy: boolean
  presentation: GenerationPresentation
  online: boolean
  connected?: boolean
  provider?: 'native' | 'comfy'
  readinessText?: string
  /** 当前生效尺寸：SD 取 sdSize，Anima/Krea2 取 width×height（宿主统一收敛）。 */
  size: string
  /** Anima/Krea2 候选尺寸（当前底模白名单，含当前值兜底）。 */
  animaSizes: string[]
  showSize: boolean
  docked: boolean
  hasResult: boolean
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

const status = computed(() => props.busy ? 'loading' : props.presentation.needsReview ? 'review' : props.error ? 'error'
  : props.presentation.completed && props.hasResult && !props.stopped ? 'success' : 'idle')
const pressRipple = usePressRipple(() => !props.busy && !props.presentation.needsReview)
const cancellationPending = computed(() => props.presentation.phase === 'cancelling' && !props.presentation.canRetryCancellation)
const actionText = computed(() => props.busy && props.presentation.phase === 'cancelling' ? props.presentation.canRetryCancellation ? '重试停止' : '正在停止…'
  : props.busy && props.presentation.phase === 'preparing' ? '取消准备' : ({ idle: '生成图片', loading: '停止绘制', success: '完成 · 再生成', error: '重试生成', review: '重新查询原请求' })[status.value])
const actionLabel = computed(() => status.value === 'success' ? '生成完成，再生成图片' : actionText.value)
const actionIcon = computed(() => ({ idle: 'spark', loading: 'close', success: 'success', error: 'refresh', review: 'info' } as const)[status.value])
const missingCharacter = computed(() => props.blockedReason?.startsWith('缺少角色 LoRA'))
const statusSummary = computed(() => props.busy || props.presentation.needsReview ? props.presentation.message : !props.online ? props.provider === 'native' ? '原生配置待检查' : '服务未连接'
  : props.error ? '绘制未完成' : props.stopped ? '已停止' : props.blockedReason ? '待补充设置' : props.connected === false ? '生成时启动服务' : '准备就绪')
const announcement = computed(() => props.busy || props.presentation.needsReview ? props.presentation.message : props.stopped ? '绘制已停止。'
  : status.value === 'error' ? `生成失败：${props.error}` : status.value === 'success' ? '生成完成，可以查看画布或再次生成。' : '')
const unavailableReason = computed(() => !props.online ? props.readinessText || '绘图配置待检查' : props.blockedReason || '')
const progressValue = computed(() => props.presentation.progress === null ? null : Math.round(props.presentation.progress * 100))
function activate() {
  if (cancellationPending.value) return
  if (props.presentation.needsReview) props.presentation.review()
  else if (props.busy) emit('cancel')
  else emit('generate')
}
const generationAction = ref<HTMLButtonElement | null>(null)
let captureMorph: typeof import('@/utils/generationControlMorph')['captureGenerationMorph'] | undefined
let cancelMorph: typeof import('@/utils/generationControlMorph')['cancelGenerationMorph'] | undefined
void import('@/utils/generationControlMorph').then(module => { captureMorph = module.captureGenerationMorph; cancelMorph = module.cancelGenerationMorph })
watch(actionText, () => { const finish = captureMorph?.(generationAction.value); if (finish) void nextTick(finish) })
const settleMorph = () => cancelMorph?.(generationAction.value)
useEventListener(document, 'visibilitychange', () => { if (document.hidden) settleMorph() })
useEventListener(window, 'atelier:motion-preference', settleMorph)
useEventListener(window.matchMedia('(prefers-reduced-motion: reduce)'), 'change', settleMorph)
onDeactivated(settleMorph); onBeforeUnmount(settleMorph)

const emit = defineEmits<{
  'update:size': [value: string]
  resize: [height: number]
  generate: []
  cancel: []
}>()
// Wrapped status/recovery text changes the sticky space too. Pause the observer
// with the retained workspace; scrolling itself never updates reactive layout.
const generationBar = ref<HTMLElement | null>(null)
const sizeActive = ref(true)
useResizeObserver(() => sizeActive.value ? generationBar.value : null, ([entry]) => {
  if (entry && sizeActive.value) emit('resize', entry.borderBoxSize[0].blockSize)
}, { box: 'border-box' })
onActivated(() => { sizeActive.value = true })
onDeactivated(() => { sizeActive.value = false })
</script>

<style scoped>
.generation-track:not(.is-indeterminate) i { transform:scaleX(var(--generation-progress,0)); }
</style>
