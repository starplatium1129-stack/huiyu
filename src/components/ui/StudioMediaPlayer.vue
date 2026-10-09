<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import { useTaskMediaSource } from '@/composables/tasks/useTaskMediaSource'
import { isRuntimeResultPath } from '@/api/runtimeTasks'

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

const emit = defineEmits<{ play: [] }>()
const container = ref<HTMLElement | null>(null)
const media = ref<HTMLMediaElement | null>(null)
const taskMedia = useTaskMediaSource(() => props.src)
const mediaSource = taskMedia.url
const mediaError = taskMedia.error
let resumeAt = 0, resumePlaying = false
let playRevision = 0
let reloadRevision = 0, automaticRecoveryAttempted = false
const reloading = ref(false)
// Capture a URL renewal before the logical-source watcher clears old playback.
// A deferred snapshot would restore the previous clip after switching sources.
watch(mediaSource, (_next, previous) => {
  playRevision++
  if (previous && media.value) {
    resumeAt = media.value.currentTime || 0
    resumePlaying = !media.value.paused
  }
}, { flush: 'sync' })
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
  const revision = ++playRevision
  if (element.paused) {
    try { await element.play() } catch {
      if (revision === playRevision && element === media.value) failed.value = true
    }
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
  const element = container.value
  if (!element?.requestFullscreen || !document.fullscreenEnabled) return
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
    else await element.requestFullscreen()
  } catch { /* 浏览器拒绝全屏（权限或用户手势）时保持内嵌播放 */ }
}

function syncFullscreen() { fullscreen.value = document.fullscreenElement === container.value }

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

async function reloadMedia() {
  const element = media.value
  if (!element || reloading.value) return
  const source = props.src, previousUrl = mediaSource.value, revision = ++reloadRevision
  reloading.value = true
  playRevision++
  try {
    await taskMedia.refresh()
    await nextTick()
    if (revision !== reloadRevision || source !== props.src || element !== media.value || mediaError.value) return
    // A renewed capability changes src itself; ordinary URLs need an explicit reload.
    if (mediaSource.value === previousUrl) {
      resumeAt = element.currentTime || 0
      resumePlaying = !element.paused
      element.load()
    }
  } finally { if (revision === reloadRevision) reloading.value = false }
}

function onMediaError() {
  failed.value = true
  // Broken media can emit metadata before failing again; only changing clips
  // resets automatic recovery, not a new capability URL or playback event.
  if (isRuntimeResultPath(props.src) && !automaticRecoveryAttempted) {
    automaticRecoveryAttempted = true
    void reloadMedia()
  } else taskMedia.stopRenewal()
}

// 换片（重新生成 / 换镜头）时把整条状态复位，避免沿用上一条的进度与错误。
watch(() => props.src, () => {
  reloadRevision++; reloading.value = false; automaticRecoveryAttempted = false
  resumeAt = 0; resumePlaying = false
  playing.value = false
  currentTime.value = 0
  duration.value = 0
  failed.value = false
})

function pause() {
  playRevision++
  resumePlaying = false
  playing.value = false
  media.value?.pause()
}
onDeactivated(pause)
defineExpose({ pause })
onBeforeUnmount(() => {
  playRevision++
  reloadRevision++
  document.removeEventListener('fullscreenchange', syncFullscreen)
  // Removing the DOM node alone can leave an in-flight media response or decoder alive.
  const element = media.value
  if (element) { element.pause(); element.removeAttribute('src'); element.load() }
})
onMounted(() => { document.addEventListener('fullscreenchange', syncFullscreen) })
</script>

<template>
  <figure ref="container" class="studio-media" :data-kind="kind">
    <video
      v-if="kind === 'video'"
      ref="media"
      class="studio-media-frame"
      :src="mediaSource || undefined"
      :poster="poster || undefined"
      :aria-label="label"
      playsinline
      preload="metadata"
      @click="togglePlay"
      @loadedmetadata="onLoadedMetadata"
      @timeupdate="onTimeUpdate"
      @play="playing = true; emit('play')"
      @pause="playing = false"
      @ended="onEnded"
      @volumechange="muted = ($event.target as HTMLMediaElement).muted"
      @error="onMediaError"
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
      @play="playing = true; emit('play')"
      @pause="playing = false"
      @ended="onEnded"
      @volumechange="muted = ($event.target as HTMLMediaElement).muted"
      @error="onMediaError"
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
      <StudioDisclosureSummary class="tw:min-h-[32px] tw:text-primary tw:cursor-pointer">查看文字稿</StudioDisclosureSummary>
      <p class="tw:mt-s-2 tw:mx-0 tw:mb-0 tw:leading-body tw:whitespace-pre-wrap">{{ transcript }}</p>
    </details>

    <p v-if="failed || mediaError" class="studio-media-error" role="status">{{ mediaError || '这段媒体暂时无法播放，可重新读取已保存的结果，或下载后查看。' }}<button class="btn btn-ghost btn-sm" type="button" :disabled="reloading" :aria-busy="reloading" @click="reloadMedia">{{ reloading ? '读取中…' : '重新读取' }}</button></p>
  </figure>
</template>

<style src="@/assets/css/components/ui/StudioMediaPlayer-0.css"></style>
