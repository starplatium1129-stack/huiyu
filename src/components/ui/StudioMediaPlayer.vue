<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { useTaskMediaSource } from '@/composables/tasks/useTaskMediaSource'

/**
 * 原生 <audio controls> / <video controls> 的替代品。
 *
 * 浏览器的媒体控件是系统皮肤，深色主题下最突兀：灰色渐变条、蓝色进度、
 * 与画室主题完全无关，也不能跟随角色强调色。这里保留原生 <audio>/<video>
 * 作为解码与播放内核（不写 controls），用项目自己的按钮与轨道接管界面，
 * 键盘与读屏仍走原生语义（button + input[type=range]）。
 */
const props = withDefaults(defineProps<{
  src: string
  /** audio 时只渲染播放条；video 额外提供全屏与画面点击播放 */
  kind?: 'audio' | 'video'
  /** 可访问名称，例如「生成的视频成片」「AI 声线试听」 */
  label: string
  poster?: string
  /** 可选字幕轨；生成结果存在字幕文件时传入。 */
  captionsSrc?: string
  /** 音频或视频的文字稿，供听障用户读取。 */
  transcript?: string
}>(), { kind: 'video', poster: '', captionsSrc: '', transcript: '' })

const media = ref<HTMLMediaElement | null>(null)
const taskMedia = useTaskMediaSource(() => props.src)
const mediaSource = taskMedia.url
const mediaError = taskMedia.error
let resumeAt = 0, resumePlaying = false
watch(mediaSource, (_next, previous) => { if (previous && media.value) { resumeAt = media.value.currentTime || 0; resumePlaying = !media.value.paused } })
const playing = ref(false)
const muted = ref(false)
const duration = ref(0)
const currentTime = ref(0)
const fullscreen = ref(false)
const failed = ref(false)

const progressPercent = computed(() =>
  duration.value > 0 ? Math.min(100, Math.max(0, (currentTime.value / duration.value) * 100)) : 0)

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00'
  const total = Math.floor(seconds)
  const minutes = Math.floor(total / 60)
  return `${minutes}:${String(total % 60).padStart(2, '0')}`
}

async function togglePlay() {
  const element = media.value
  if (!element) return
  if (element.paused) {
    try { await element.play() } catch { failed.value = true }
  } else {
    element.pause()
  }
}

function onSeek(event: Event) {
  const element = media.value
  if (!element) return
  const next = Number((event.target as HTMLInputElement).value)
  if (!Number.isFinite(next)) return
  element.currentTime = next
  currentTime.value = next
}

function toggleMute() {
  const element = media.value
  if (!element) return
  element.muted = !element.muted
  muted.value = element.muted
}

async function toggleFullscreen() {
  const element = media.value as HTMLVideoElement | null
  if (!element?.requestFullscreen || !document.fullscreenEnabled) return
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
    else await element.requestFullscreen()
  } catch { /* 浏览器拒绝全屏（权限或用户手势）时保持内嵌播放 */ }
}

function syncFullscreen() { fullscreen.value = document.fullscreenElement === media.value }

function onLoadedMetadata() {
  const element = media.value
  if (!element) return
  failed.value = false
  duration.value = Number.isFinite(element.duration) ? element.duration : 0
  if (resumeAt) { element.currentTime = resumeAt; resumeAt = 0 }
  if (resumePlaying) { resumePlaying = false; void element.play().catch(() => {}) }
}

function onTimeUpdate() {
  const element = media.value
  if (!element) return
  currentTime.value = element.currentTime
}

function onEnded() { playing.value = false }

// 换片（重新生成 / 换镜头）时把整条状态复位，避免沿用上一条的进度与错误。
watch(() => props.src, () => {
  resumeAt = 0; resumePlaying = false
  playing.value = false
  currentTime.value = 0
  duration.value = 0
  failed.value = false
})

onBeforeUnmount(() => { document.removeEventListener('fullscreenchange', syncFullscreen) })
onMounted(() => { document.addEventListener('fullscreenchange', syncFullscreen) })
</script>

<template>
  <figure class="studio-media" :data-kind="kind">
    <video
      v-if="kind === 'video'"
      ref="media"
      class="studio-media-frame"
      :src="mediaSource"
      :poster="poster || undefined"
      :aria-label="label"
      playsinline
      preload="metadata"
      @click="togglePlay"
      @loadedmetadata="onLoadedMetadata"
      @timeupdate="onTimeUpdate"
      @play="playing = true"
      @pause="playing = false"
      @ended="onEnded"
      @volumechange="muted = ($event.target as HTMLMediaElement).muted"
      @error="failed = true; taskMedia.refresh()"
    >
      <track v-if="captionsSrc" kind="captions" :src="captionsSrc" srclang="zh-CN" label="中文字幕" default />
    </video>
    <audio
      v-else
      ref="media"
      class="studio-media-audio"
      :src="src"
      :aria-label="label"
      preload="metadata"
      @loadedmetadata="onLoadedMetadata"
      @timeupdate="onTimeUpdate"
      @play="playing = true"
      @pause="playing = false"
      @ended="onEnded"
      @volumechange="muted = ($event.target as HTMLMediaElement).muted"
      @error="failed = true"
    ></audio>

    <div class="studio-media-bar">
      <button type="button" class="studio-media-btn" :aria-label="playing ? `暂停${label}` : `播放${label}`" @click="togglePlay">
        <ArchiveIcon :name="playing ? 'pause' : 'play'" />
      </button>
      <input
        class="studio-media-seek"
        type="range"
        min="0"
        :max="duration || 0"
        step="0.01"
        :value="currentTime"
        :disabled="!duration"
        :aria-label="`${label}播放进度`"
        :style="{ '--progress': progressPercent + '%' }"
        @input="onSeek"
      />
      <span class="studio-media-time">{{ formatTime(currentTime) }} / {{ formatTime(duration) }}</span>
      <button type="button" class="studio-media-btn" :aria-label="muted ? `取消静音${label}` : `静音${label}`" @click="toggleMute">
        <ArchiveIcon :name="muted ? 'mute' : 'sound'" />
      </button>
      <button
        v-if="kind === 'video'"
        type="button"
        class="studio-media-btn"
        :aria-label="fullscreen ? `退出全屏${label}` : `全屏播放${label}`"
        @click="toggleFullscreen"
      >
        <ArchiveIcon :name="fullscreen ? 'compress' : 'expand'" />
      </button>
    </div>

    <details v-if="transcript" class="studio-media-transcript">
      <summary>查看文字稿</summary>
      <p>{{ transcript }}</p>
    </details>

    <p v-if="failed || mediaError" class="studio-media-error" role="status">{{ mediaError || '这段媒体暂时无法播放，可重新读取已保存的结果，或下载后查看。' }}<button class="btn btn-ghost btn-sm" type="button" @click="taskMedia.refresh()">重新读取</button></p>
  </figure>
</template>

<style>
.studio-media {
  display: grid;
  gap: var(--s-2);
  margin: 0;
  min-width: 0;
}
.studio-media-frame {
  display: block;
  width: 100%;
  /* 画面高度上限由上下文给：视频工作台用 --media-max-height 放宽到 72vh */
  max-height: var(--media-max-height, 60vh);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-xl);
  background: var(--bg-deep);
  cursor: pointer;
}
.studio-media[data-kind='audio'] .studio-media-audio { display: none; }

.studio-media-bar {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  min-height: 44px;
  padding: var(--s-1) var(--s-2);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-pill);
  background: var(--bg-surface);
}
.studio-media-btn {
  display: grid;
  place-items: center;
  flex: 0 0 34px;
  width: 34px;
  height: 34px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 50%;
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
  transition: background-color var(--motion-hover) var(--ease-out), border-color var(--motion-hover) var(--ease-out);
}
.studio-media-btn:hover { border-color: var(--border-soft); background: var(--bg-hover); }
.studio-media-btn:disabled { color: var(--text-disabled); cursor: not-allowed; }
.studio-media-btn .archive-icon { width: 16px; height: 16px; }

.studio-media-time {
  flex: 0 0 auto;
  color: var(--text-secondary);
  font: 500 var(--fs-label-sm) var(--font-mono);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* ── 进度轨道 ──
   不写原生控件外观：appearance 全关，用自定义属性 --progress 画已播段，
   仅改背景与 transform，不触发重排。 */
.studio-media-seek {
  flex: 1 1 auto;
  min-width: 0;
  height: 24px;
  margin: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
  -webkit-appearance: none;
  appearance: none;
}
.studio-media-seek:disabled { cursor: not-allowed; }
.studio-media-seek::-webkit-slider-runnable-track {
  height: 4px;
  border-radius: var(--r-pill);
  background: linear-gradient(
    to right,
    var(--accent) 0 var(--progress, 0%),
    color-mix(in srgb, var(--text-muted) 30%, transparent) var(--progress, 0%) 100%
  );
}
.studio-media-seek::-webkit-slider-thumb {
  width: 14px;
  height: 14px;
  margin-top: -5px;
  border: 3px solid var(--bg-surface);
  border-radius: 50%;
  background: var(--accent);
  box-shadow: var(--shadow-sm);
  cursor: grab;
  -webkit-appearance: none;
}
.studio-media-seek::-moz-range-track {
  height: 4px;
  border-radius: var(--r-pill);
  background: color-mix(in srgb, var(--text-muted) 30%, transparent);
}
.studio-media-seek::-moz-range-progress {
  height: 4px;
  border-radius: var(--r-pill);
  background: var(--accent);
}
.studio-media-seek::-moz-range-thumb {
  width: 8px;
  height: 8px;
  border: 3px solid var(--bg-surface);
  border-radius: 50%;
  background: var(--accent);
  box-shadow: var(--shadow-sm);
  cursor: grab;
}
.studio-media-seek:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: var(--r-sm); }

.studio-media-transcript {
  padding: var(--s-3);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-md);
  background: var(--bg-surface);
  color: var(--text-secondary);
  font-size: var(--fs-body-sm);
}
.studio-media-transcript summary { min-height: 32px; color: var(--text-primary); cursor: pointer; }
.studio-media-transcript p { margin: var(--s-2) 0 0; line-height: var(--lh-body); white-space: pre-wrap; }

.studio-media-error {
  margin: 0;
  color: var(--danger);
  font-size: var(--fs-label-sm);
}

@media (max-width: 600px) {
  .studio-media-btn { flex-basis: 40px; width: 40px; height: 40px; }
}
@media (forced-colors: active) {
  .studio-media-bar { border-color: CanvasText; }
  .studio-media-seek::-webkit-slider-runnable-track { background: CanvasText; }
}
</style>
