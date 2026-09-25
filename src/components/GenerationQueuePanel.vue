<template>
  <div v-if="total" class="sd-queue advanced-decision">
    <div class="sd-queue-head">
      <!--
        2026-09-06 体验报告 F6：位置与总量分别来自 done / batchTotal——
        旧算法 total（等待+在途）随完成缩水，运行中恒显示「第 1 张」。
        运行中：第 done+1 / 共 done+total；暂停空闲：已完成 done · 等待 N。
      -->
      <span>出图队列 · {{ headerText }}</span>
      <span class="row-tight">
        <button v-if="paused" class="btn btn-ghost btn-sm" type="button" @click="emit('resume')">继续</button>
        <button v-else class="btn btn-ghost btn-sm" type="button" @click="emit('pause')">暂停</button>
        <button class="btn btn-ghost btn-sm" type="button" @click="emit('clear')">清空等待</button>
      </span>
    </div>
    <p v-if="pausedReason" class="sd-queue-reason">{{ pausedReason }}</p>
    <div class="sd-queue-list">
      <div v-if="activeJob" class="sd-queue-item sd-queue-item-active">
        <BorderBeam size="sm" color-variant="accent" border-radius="var(--r-md)" />
        <!-- 速度线：斜向细线持续流动，一眼看出"这条在跑" -->
        <span class="fx-speed-lines" aria-hidden="true"></span>
        <span class="sd-queue-index">生成中</span>
        <div class="sd-queue-copy">
          <div class="sd-queue-title">{{ activeJob.title }}</div>
          <div class="sd-queue-meta">{{ activeJob.size }} · seed {{ seedLabel(activeJob.seed) }}</div>
          <!-- 进度条用 scaleX 表达（动效铁律：只动 transform，不逐帧改 width）；
               后端给不出进度时退回 indeterminate，不伪造百分比。 -->
          <div
            class="sd-queue-progress"
            role="progressbar"
            :aria-valuenow="progressKnown ? progressPercent : undefined"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-label="progressKnown ? '当前任务生成进度' : '当前任务生成进行中'"
          >
            <i :class="{ 'is-indeterminate': !progressKnown }" :style="barStyle"></i>
          </div>
        </div>
        <strong class="sd-queue-percent">{{ progressKnown ? progressPercent + '%' : '进行中' }}</strong>
      </div>
      <!-- 出完一张的瞬间演出：集中线 + 拟声词。
           纯装饰（aria-hidden），不承载信息，删掉不影响可用性。 -->
      <div v-if="justFinished" class="sd-queue-burst" aria-hidden="true">
        <span class="fx-focus-lines is-bursting"></span>
        <span class="fx-onome is-popping">ドンッ</span>
      </div>
      <div v-for="(job, index) in queue" :key="job.id" class="sd-queue-item">
        <span class="sd-queue-index">{{ waitingIndex(index) }}</span>
        <div class="sd-queue-copy">
          <div class="sd-queue-title">{{ job.title }}</div>
          <div class="sd-queue-meta">{{ job.size }} · seed {{ seedLabel(job.seed) }}</div>
        </div>
        <button class="sd-queue-remove" type="button" aria-label="移出队列" @click="emit('remove', job.id)">×</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import BorderBeam from '@/components/visual/BorderBeam.vue'
import type { SDQueueJob } from '@/composables/generation/useSDQueue'
import '@/assets/css/director/components/GenerationQueuePanel.css'

const props = defineProps<{
  total: number
  /** 本轮已成功出完的张数（只增不减，新一轮归零）。 */
  done: number
  paused: boolean
  activeJob: Readonly<SDQueueJob> | null
  queue: ReadonlyArray<Readonly<SDQueueJob>>
  /** 当前任务进度 0–1；null = 后端给不出进度，走 indeterminate。 */
  progress?: number | null
  /** 暂停原因（队列在任务失败时自动暂停，这里说明为什么）。 */
  pausedReason?: string
}>()

const emit = defineEmits<{
  pause: []
  resume: []
  clear: []
  remove: [id: string]
}>()

function seedLabel(seed: number) {
  return seed < 0 ? '随机' : seed
}

/** 本轮总量固定为 done+total（total=等待+在途），分母不再随完成漂移（F6）。 */
const batchTotal = computed(() => props.done + props.total)

/** 头部进度文案：运行中报「第几/共几」，暂停空闲时如实报「已完成·等待」。 */
const headerText = computed(() => {
  const pausedSuffix = props.paused ? '（已暂停）' : ''
  if (props.activeJob) return `第 ${props.done + 1} / 共 ${batchTotal.value}${pausedSuffix}`
  return `已完成 ${props.done} · 等待 ${props.queue.length} 张${pausedSuffix}`
})

/** 等待列表的绝对序号：接续「已完成 + 在途」之后，不再是每行都从 1 数起。 */
function waitingIndex(index: number) {
  return props.done + (props.activeJob ? 1 : 0) + index + 1
}

/** 未传 / null 都算「后端给不出进度」，统一走 indeterminate。 */
const progressKnown = computed(() => typeof props.progress === 'number')

const progressPercent = computed(() =>
  progressKnown.value ? Math.max(0, Math.min(100, Math.round((props.progress as number) * 100))) : 0)

const barStyle = computed(() => ({ '--progress': `${progressPercent.value / 100}` }))

// 出完一张的瞬间演出。只在「有任务在跑 → 没有任务在跑」这一次跃迁时触发，
// 队列里还有后续任务时也能看到，所以每张图出完都有一次正反馈。
// 用 activeJob 而不是 total 判定：total 归零时整个面板会 v-if 掉，
// 演出就渲染不出来了（最后一张反而看不到，不合逻辑）。
const justFinished = ref(false)
let finishTimer = 0
watch(
  () => props.activeJob,
  (now, prev) => {
    if (!prev || now) return
    justFinished.value = true
    window.clearTimeout(finishTimer)
    finishTimer = window.setTimeout(() => { justFinished.value = false }, 620)
  },
)
onBeforeUnmount(() => window.clearTimeout(finishTimer))
</script>
