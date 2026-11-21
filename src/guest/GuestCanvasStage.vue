<script setup lang="ts">
import { computed } from 'vue'
import atelierStudioArt from '@/assets/illustrations/atelier-studio-768.webp'
import neneStudyArt from '@/assets/illustrations/nene-moonlit-study-header-1024.webp'
import natsumeCafeArt from '@/assets/illustrations/natsume-rainy-cafe-header-1024.webp'
import StudioOrbitSpinner from '@/components/ui/StudioOrbitSpinner.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import BorderBeam from '@/components/visual/BorderBeam.vue'
import { getGuestCharacterAmbience } from './guestPresets'
import type { GuestHistoryItem } from './useGuestHistory'
import './guestCanvas.css'

const props = defineProps<{
  current: GuestHistoryItem | null
  history: readonly GuestHistoryItem[]
  busy: boolean
  cancelling: boolean
  checking: boolean
  ready: boolean
  hasAttempt: boolean
  progress?: number
  notice: string
  elapsedSeconds: number
  activeCharacterId?: string
  activeCharacterTitle?: string
  contextTitle: string
  hasPromptOrSelection: boolean
  canDraw: boolean
}>()

const emit = defineEmits<{
  openLightbox: []
  download: [item: GuestHistoryItem]
  redraw: []
  clearCanvas: []
  cancel: []
  selectHistory: [item: GuestHistoryItem]
  applyHistory: [item: GuestHistoryItem]
  removeHistory: [item: GuestHistoryItem]
  pickCharacter: []
  tryExample: []
  drawNow: []
}>()

const emptyArtwork = computed(() => {
  if (props.activeCharacterId === 'nene') {
    return { src: neneStudyArt, width: 1024, height: 576, framed: true }
  }
  if (props.activeCharacterId === 'natsume') {
    return { src: natsumeCafeArt, width: 1024, height: 576, framed: true }
  }
  return { src: atelierStudioArt, width: 768, height: 512, framed: false }
})

const ambience = computed(() =>
  getGuestCharacterAmbience(props.activeCharacterId, props.activeCharacterTitle),
)

const headingMeta = computed(() => {
  const item = props.current
  if (!item) return ''
  const parts: string[] = []
  if (item.width && item.height) parts.push(`${item.width} × ${item.height}`)
  if (typeof item.seed === 'number') parts.push(`#${item.seed}`)
  if (item.elapsedMs > 0) parts.push(`${Math.max(1, Math.round(item.elapsedMs / 1000))}s`)
  return parts.join(' · ')
})

const progressPercent = computed(() => {
  if (typeof props.progress !== 'number') return ''
  return `${Math.round(Math.max(0, Math.min(1, props.progress)) * 100)}%`
})
</script>

<template>
  <section class="guest-canvasArea" aria-labelledby="guest-canvas-title">
    <div class="guest-canvasPanel">
      <BorderBeam
        v-if="busy"
        class="guest-canvasBeam"
        :duration="8.4"
        :border-width="1.2"
        color-variant="dual"
        :glow="true"
        border-radius="var(--r-xl)"
      />

      <header class="canvas-heading guest-canvasHeader">
        <div class="guest-canvasIdentity">
          <span class="workbench-heading-icon" aria-hidden="true">
            <ArchiveIcon name="image" />
          </span>
          <div class="guest-canvasHeadingText">
            <h2 id="guest-canvas-title">{{ current ? current.title : contextTitle }}</h2>
            <span v-if="headingMeta" class="guest-canvasMeta">{{ headingMeta }}</span>
          </div>
        </div>

        <div v-if="current" class="guest-canvasActions">
          <button
            class="btn btn-ghost btn-sm"
            type="button"
            @click="emit('download', current)"
          >
            <ArchiveIcon name="download" />下载原图
          </button>
          <button
            class="btn btn-ghost btn-sm"
            type="button"
            @click="emit('openLightbox')"
          >
            <ArchiveIcon name="expand" />放大查看
          </button>
          <StudioTooltip anchor :content="busy ? '正在绘制中' : !ready ? '等待房主画室就绪' : '按当前设定再画一张新图'">
            <button
              class="btn btn-ghost btn-sm"
              type="button"
              :disabled="!canDraw || busy"
              @click="emit('redraw')"
            >
              <ArchiveIcon name="refresh" />再来一张
            </button>
          </StudioTooltip>
          <button
            class="btn btn-quiet btn-sm"
            type="button"
            :disabled="busy"
            @click="emit('clearCanvas')"
          >
            <ArchiveIcon name="close" />清空
          </button>
        </div>
      </header>

      <div class="guest-stage" :data-result="!!current" :data-busy="busy" :aria-busy="busy">
        <button
          v-if="current"
          type="button"
          class="guest-artButton"
          aria-label="放大查看作品细节"
          @click="emit('openLightbox')"
        >
          <img
            :src="current.url"
            :alt="current.title || '生成的画面'"
            class="guest-result"
          />
          <span class="guest-artZoomHint" aria-hidden="true">
            <ArchiveIcon name="expand" />点击放大看细节
          </span>
        </button>

        <div v-else-if="!busy" class="guest-emptyCanvas">
          <Transition name="guest-art-fade" mode="out-in">
            <img
              :key="emptyArtwork.src"
              :src="emptyArtwork.src"
              :width="emptyArtwork.width"
              :height="emptyArtwork.height"
              :class="['guest-emptyArt', { 'is-framed': emptyArtwork.framed }]"
              alt=""
              aria-hidden="true"
              draggable="false"
            />
          </Transition>
          <h3 class="guest-emptyTitle">{{ ambience.title }}</h3>
          <p class="guest-emptyQuote">{{ ambience.quote }}</p>
          <div class="guest-emptyActions">
            <template v-if="!hasPromptOrSelection">
              <button class="btn btn-primary" type="button" @click="emit('pickCharacter')">
                <ArchiveIcon name="character" />挑选角色
              </button>
              <button class="btn btn-ghost" type="button" @click="emit('tryExample')">
                <ArchiveIcon name="book" />试试雨夜书店
              </button>
              <button
                class="btn btn-quiet"
                type="button"
                :disabled="!canDraw"
                @click="emit('drawNow')"
              >
                <ArchiveIcon name="spark" />直接试画一张
              </button>
            </template>
            <template v-else>
              <button
                class="btn btn-primary"
                type="button"
                :disabled="!canDraw"
                @click="emit('drawNow')"
              >
                <ArchiveIcon name="spark" />{{ checking ? '正在连接…' : hasAttempt ? '继续读取原图' : '开始绘制' }}
              </button>
              <button class="btn btn-ghost" type="button" @click="emit('pickCharacter')">
                <ArchiveIcon name="character" />{{ activeCharacterId ? '换个角色' : '挑选角色' }}
              </button>
            </template>
          </div>
        </div>

        <div
          v-if="busy"
          class="guest-busyOverlay"
          :class="{ 'is-over-art': !!current }"
          role="status"
          aria-live="polite"
        >
          <div class="guest-busyCard">
            <StudioOrbitSpinner />
            <div class="guest-busyCopy">
              <strong>{{ notice || '正在向房主发送绘制请求…' }}</strong>
              <div class="guest-busyNumbers">
                <span v-if="progressPercent">{{ progressPercent }}</span>
                <span>已用时 {{ elapsedSeconds }} 秒</span>
              </div>
            </div>
            <progress :value="progress" max="1" aria-label="出图进度" />
            <button
              class="btn btn-danger btn-sm"
              type="button"
              :disabled="cancelling"
              @click="emit('cancel')"
            >
              <ArchiveIcon name="stop" />{{ cancelling ? '正在停止…' : '停止绘制' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <section v-if="history.length" class="guest-filmstrip" aria-label="本次试玩作品">
      <div class="guest-filmstripHead">
        <div class="guest-filmstripTitle">
          <ArchiveIcon name="gallery" />
          <strong>本次画作</strong>
          <span class="guest-filmstripCount">{{ history.length }}</span>
          <small>仅存于当前页，刷新会清空，请及时下载</small>
        </div>
        <button
          v-if="current"
          class="btn btn-quiet btn-sm"
          type="button"
          @click="emit('applyHistory', current)"
        >
          <ArchiveIcon name="refresh" />套用此图设定
        </button>
      </div>

      <div class="guest-filmList" role="list">
        <div
          v-for="item in history"
          :key="item.id"
          role="listitem"
          class="guest-filmItem"
          :data-active="current?.id === item.id"
        >
          <StudioTooltip :content="item.title">
            <button
              type="button"
              class="guest-filmThumb"
              :aria-pressed="current?.id === item.id"
              :aria-label="`查看作品：${item.title}`"
              @click="emit('selectHistory', item)"
            >
              <img :src="item.url" :alt="item.title" loading="lazy" />
              <span v-if="current?.id === item.id" class="guest-filmSelectedMark" aria-hidden="true">
                <ArchiveIcon name="success" />
              </span>
            </button>
          </StudioTooltip>
          <StudioTooltip content="移除这张记录">
            <button
              type="button"
              class="guest-filmRemove"
              :aria-label="`移除作品：${item.title}`"
              @click.stop="emit('removeHistory', item)"
            >
              <ArchiveIcon name="close" />
            </button>
          </StudioTooltip>
        </div>
      </div>
    </section>
  </section>
</template>
