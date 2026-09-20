<template>
  <!-- stage-slot：col-center 的画布槽位锚点（layout.css 以它固定中栏排序首位） -->
  <div class="stage-slot">
    <!-- Stage placeholder：plans/002 交接收尾——v-if + stage-swap 过渡，
         占位层淡出让位（结果层入场由 result-image-wrap 的 directorViewIn
         与图片 aicsBloomReveal 承担，不做双重驱动） -->
    <Transition name="stage-swap">
      <section
        v-if="!displayResultUrl"
        class="stage-placeholder"
      :class="{
        'is-generating': generationBusy,
        'is-error': !!generationError,
        'is-paused': generationStopped,
      }"
      aria-label="成片监看区"
    >
      <div class="stage-chrome">
        <span>画布预览</span>
        <span class="stage-ready">
          {{ generationBusy ? '正在显影' : (generationError ? '需要处理' : (generationStopped ? '已暂停' : '等待创作')) }}
        </span>
      </div>
      <i class="stage-magic-ring" aria-hidden="true"></i>
      <img class="stage-muse nene" :src="stageMuseUrl.nene" alt="" aria-hidden="true" decoding="async">
      <img class="stage-muse natsume" :src="stageMuseUrl.natsume" alt="" aria-hidden="true" decoding="async">
      <div class="stage-message">
        <div v-if="generationBusy" class="stage-generating-copy">
          <div class="stage-generating-title">心动画面正在显影…</div>
          <div class="stage-generating-sub">
            {{ generationStatusText || '正在绘制这一幕，请稍候。' }}
            <template v-if="generationProgress !== null"> {{ Math.round(generationProgress * 100) }}%</template>
            <template v-else-if="drawEngine !== 'sd'"> · 已等待 {{ animaElapsed }} 秒</template>
            <details v-if="drawEngine !== 'sd' && animaCurrentNode" class="stage-progress-details"><summary>生成详情</summary>当前步骤：{{ animaCurrentNode }}</details>
          </div>
          <div class="stage-progress-ring" :class="{ 'is-indeterminate': generationProgress === null }">
            <i :style="{ '--progress': (generationProgress ?? 0) * 100 + '%' }"></i>
          </div>
        </div>
        <div v-else-if="generationError" class="stage-idle">
          <div class="stage-placeholder-title">这次画面未能生成</div>
          <button class="btn btn-ghost" type="button" @click="$emit('openRecovery')">查看恢复选项</button>
          <div class="stage-placeholder-copy">
            查看错误原因，调整后再试一次。
            <span v-if="generationError" class="stage-error-detail">（{{ generationError }}）</span>
          </div>
          <div class="stage-quick-actions">
            <button class="btn btn-primary" type="button" @click="$emit('generate')">重新生成</button>
            <!-- F2：本次失败不毁掉上一张未入册成片——它还在暂存里，一键找回 -->
            <button v-if="hasStashedResult" class="btn btn-ghost" type="button" @click="$emit('restoreStashed')">
              找回上一张未入册成片
            </button>
          </div>
        </div>
        <div v-else-if="generationStopped" class="stage-idle">
          <div class="stage-placeholder-title">已停止生成</div>
          <div class="stage-placeholder-copy">
            可以调整场景与参数，准备好后继续。
          </div>
          <div class="stage-quick-actions">
            <button class="btn btn-primary" type="button" @click="$emit('generate')">继续生成</button>
            <button v-if="hasStashedResult" class="btn btn-ghost" type="button" @click="$emit('restoreStashed')">
              找回上一张未入册成片
            </button>
          </div>
        </div>
        <div v-else class="stage-idle">
          <div class="atelier-canvas-mark" aria-hidden="true"><ArchiveIcon name="image" /></div>
          <div class="stage-placeholder-title">想把哪一刻，留在画里？</div>
          <div class="stage-placeholder-copy">
            选好角色，再挑一个场景或写下构思。生成后，把喜欢的这一刻存入作品册。
          </div>
          <div class="stage-quick-actions">
            <button class="btn btn-primary" type="button" @click="$emit('exploreScenes')"><ArchiveIcon name="scene" /> 挑选场景</button>
            <button
              v-if="drawEngine === 'anima'"
              class="btn btn-ghost"
              type="button"
              title="导入任意外部本地图片，进行智能语义识别与局部换装"
              @click="$emit('openInpaint')"
            >
              <ArchiveIcon name="inpaint" />
              <span>导入图片换装</span>
            </button>
            <button class="btn btn-ghost" type="button"
              :disabled="interrogateBusy"
              :title="(interrogateMode === 'caption' ? '从图片提取自然语言描述（适合 Krea）' : '从图片提取特征标签（适合 Anima/SD）') + '；也可聚焦后直接粘贴图片'"
              @click="triggerInterrogatePick"
              @paste="onInterrogatePaste">
              <ArchiveIcon name="search" />
              <span>{{ interrogateBusy ? '正在读取图片…' : '从图片提取灵感' }}</span>
            </button>

          </div>
          <div v-if="interrogateError" class="stage-interrogate-error" role="alert">{{ interrogateError }}</div>
          <input ref="interrogateInputRef" class="sr-only" type="file" accept="image/*" @change="onInterrogateFile" />
        </div>
      </div>
    </section>
    </Transition>

    <!-- Result image -->
    <div v-if="displayResultUrl" class="result-image-wrap archive-canvas">
      <ImageSplitCompare
        v-if="inpaintCompareActive && inpaintOriginalUrl"
        :before-src="inpaintOriginalUrl"
        :after-src="displayResultUrl"
        before-label="换装前原图"
        after-label="换装后成片"
      />
      <img v-else class="result-image" :src="displayResultUrl" alt="当前生成的画面成片" />
      <DirectorResultTools
        v-bind="{ generationBusy, interrogateBusy, interrogateMode, displayResultUrl, drawEngine, inpaintOriginalUrl, inpaintCompareActive, shotsPending, hasPrevResult, resultArchived, savingResult, resultTemporary }"
        @interrogateCurrent="interrogateCurrentImage" @interrogateUpload="triggerInterrogatePick"
        @openInpaint="$emit('openInpaint')" @update:inpaintCompareActive="$emit('update:inpaintCompareActive', $event)"
        @upscale="$emit('upscale')" @goVideo="$emit('goVideo')" @addToShots="$emit('addToShots')" @goShots="$emit('goShots')"
        @saveResult="$emit('saveResult')" @openCompare="$emit('openCompare')" @clearResult="$emit('clearResult')"
      />
      <div v-if="interrogateError && displayResultUrl" class="stage-interrogate-error" role="alert">{{ interrogateError }}</div>
    </div>
    <!-- 供两态共用的上传入口 -->
    <input ref="interrogateInputRef2" class="sr-only" type="file" accept="image/*" @change="onInterrogateFile" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, defineAsyncComponent } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import ImageSplitCompare from '@/components/visual/ImageSplitCompare.vue'
import { useInterrogate } from '@/composables/useInterrogate'
import type { InterrogateResult } from '@/composables/useInterrogate'
import '@/assets/css/director/components/DirectorStagePanel.css'

const props = defineProps<{
  displayResultUrl: string
  generationBusy: boolean
  generationError: string | null
  generationStopped: boolean
  generationStatusText: string | null
  generationProgress: number | null
  generationProgressStyle: Record<string, string>
  animaElapsed: number
  animaCurrentNode: string
  drawEngine: string
  inpaintOriginalUrl: string | null
  inpaintCompareActive: boolean
  shotsPending: number
  hasPrevResult: boolean
  /** 当前结果是否已入册（null = 画布无结果，不显示徽章）。 */
  resultArchived?: boolean | null
  savingResult?: boolean
  resultTemporary?: boolean
  /** Anima/Krea 暂存里还有上一张未入册成片（失败/取消后可找回）。 */
  hasStashedResult?: boolean
}>()

// Result-only tools load after an image exists.
const DirectorResultTools = defineAsyncComponent(() => import('./DirectorResultTools.vue'))

const emit = defineEmits<{
  generate: []
  openInpaint: []
  openRecovery: []
  exploreScenes: []
  'update:inpaintCompareActive': [value: boolean]
  upscale: []
  goVideo: []
  addToShots: []
  goShots: []
  saveResult: []
  openCompare: []
  clearResult: []
  restoreStashed: []
  interrogateResult: [result: InterrogateResult]
  interrogateError: [message: string]
}>()

const stageMuseUrl = {
  nene: '/assets/characters/nene-official.webp',
  natsume: '/assets/characters/natsume-official.webp',
}

const interrogateInputRef = ref<HTMLInputElement | null>(null)
const interrogateInputRef2 = ref<HTMLInputElement | null>(null)
const { busy: interrogateBusy, error: interrogateErrorRaw, interrogate } = useInterrogate()
const interrogateError = computed(() => interrogateErrorRaw.value)
const interrogateMode = computed(() => props.drawEngine === 'krea2' ? 'caption' as const : 'tag' as const)

function triggerInterrogatePick() {
  // 有结果时优先用结果态外层的 input：空闲态 input 在 v-show=false 的舞台里，
  // 部分 WebView/浏览器对 display:none 祖先内的 file input 不弹选择器。
  var target = props.displayResultUrl ? interrogateInputRef2.value : interrogateInputRef.value
  if (!target) target = props.displayResultUrl ? interrogateInputRef.value : interrogateInputRef2.value
  if (target) target.click()
}

async function onInterrogateFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files && input.files[0]
  // 清空以便同文件可二次触发
  input.value = ''
  if (file) await runInterrogateFile(file)
}

/**
 * 剪贴板里的图片直接反推（2026-08-30 UX 审计 P2）。
 *
 * 本地反推此前只能走文件选择器，而真要用的那一刻，图往往已经在剪贴板里了
 * （刚截的图、从参考站复制的），多一趟「打开对话框找文件」纯属多余。
 * 监听挂在按钮上是因为浏览器只把 paste 派发给焦点元素，按钮天然可聚焦。
 */
function onInterrogatePaste(e: ClipboardEvent) {
  const image = Array.from(e.clipboardData?.files ?? []).find(f => f.type.startsWith('image/'))
  if (!image) return
  e.preventDefault()
  void runInterrogateFile(image)
}

/** 反推一张图片：文件选择与剪贴板粘贴共用这一条路径 */
async function runInterrogateFile(file: File) {
  try {
    const result = await interrogate(file, interrogateMode.value, 0.35)
    if (result) emit('interrogateResult', result)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    emit('interrogateError', msg)
    console.warn('[interrogate]', msg)
  }
}

async function interrogateCurrentImage() {
  if (!props.displayResultUrl) {
    triggerInterrogatePick()
    return
  }
  let file: File
  try {
    var res = await fetch(props.displayResultUrl)
    if (!res.ok) throw new Error('获取当前成片失败')
    var blob = await res.blob()
    file = new File([blob], 'current_result.png', { type: blob.type || 'image/png' })
  } catch (e) {
    // 取图失败回落到上传，让用户手动选图
    const msg = e instanceof Error ? e.message : String(e)
    console.warn('[interrogate] fetch current image failed:', msg)
    triggerInterrogatePick()
    return
  }
  try {
    var result = await interrogate(file, interrogateMode.value, 0.35)
    if (result) emit('interrogateResult', result)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    emit('interrogateError', msg)
    console.warn('[interrogate]', msg)
  }
}
</script>

<style scoped>
/* F2：入册状态徽章（设计令牌，深色模式对比度由令牌保证） */
.stage-archive-badge {
  align-self: center;
  padding: 3px var(--s-2);
  border-radius: var(--r-pill);
  font: 700 var(--fs-mono-xs) var(--font-mono);
}
.stage-archive-badge[data-archived="true"] {
  background: color-mix(in srgb, var(--success) 14%, transparent);
  color: var(--success-text);
}
.stage-archive-badge[data-archived="false"] {
  background: color-mix(in srgb, var(--warning) 12%, transparent);
  color: var(--warning-text);
}
</style>
