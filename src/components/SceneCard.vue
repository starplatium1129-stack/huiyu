<template>
  <div
    class="sc"
    :class="[`sc-${mode}`, { 'sc-static': !clickable }]"
    :data-rating="contentRating"
    :role="clickable ? 'button' : undefined"
    :tabindex="clickable ? 0 : undefined"
    @click="clickable && emit('pick', scene)"
    @keydown.enter.prevent="clickable && emit('pick', scene)"
    @keydown.space.prevent="clickable && emit('pick', scene)"
    @mousemove="onSpotMove"
    @mouseenter="onSpotEnter"
    @mouseleave="onSpotLeave"
  >
    <div class="sc-band">
      <div v-if="thumbId" class="sc-thumb-skeleton" :class="{ visible: !thumbLoaded && !thumbFailed }" aria-hidden="true"></div>
      <img
        v-if="thumbId"
        class="sc-thumb"
        :class="{ 'sc-thumb-r18': contentRating === 'R18', 'sc-thumb-missing': thumbFailed, 'sc-thumb-ready': thumbLoaded }"
        :src="thumbSrc"
        :srcset="`${thumbSrc} 320w, ${thumbSrc} 640w`"
        sizes="(max-width: 760px) 50vw, (max-width: 1000px) 33vw, 25vw"
        alt=""
        loading="lazy"
        decoding="async"
        fetchpriority="auto"
        @load="thumbLoaded = true"
        @error="thumbFailed = true"
      />
      <span v-if="thumbFailed || !thumbId" class="sc-preview-unavailable">样张暂缺 · 场景可用</span>
      <span v-if="thumbId" class="sc-id">{{ thumbId.toUpperCase() }}</span>
      <span v-if="contentRating === 'R18'" class="sc-badge sc-rating r18">R18</span>
      <span v-else-if="contentRating === 'R15'" class="sc-badge sc-rating r15">R15</span>
      <span v-if="mode === 'grid'" class="sc-cat">{{ scene.category || '场景' }}</span>
      <slot name="band" :scene="scene" />
    </div>

    <div class="sc-body">
      <div class="sc-title">{{ scene.title || '未命名' }}</div>
      <div v-if="mode !== 'strip'" class="sc-story">{{ scene.story || '' }}</div>
      <div v-if="!suppressTags" class="sc-tags">
        <span v-for="t in tags" :key="t" class="sc-tag">{{ t }}</span>
      </div>
      <div class="sc-meta">
        <span class="sc-meta-r">{{ metaText }}</span>
      </div>
      <slot name="body" :scene="scene" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'

export interface SceneCardScene {
  [key: string]: unknown
  id: string
  title?: string
  story?: string
  category?: string
  rating?: string
  mature?: boolean
  tags?: string[]
  emotion?: string
  season?: string
  weather?: string
  timeOfDay?: string
}

const props = withDefaults(defineProps<{
  scene: SceneCardScene
  mode?: 'grid' | 'strip' | 'recent'
  clickable?: boolean
  suppressTags?: boolean
  meta?: string
  imgVersion?: string | number
}>(), {
  mode: 'grid',
  clickable: undefined,
  suppressTags: false,
})

const emit = defineEmits<{ pick: [scene: SceneCardScene] }>()

const TAG_BLOCKLIST = ['official_cg', 'visual_audited']

const thumbFailed = ref(false)
const thumbLoaded = ref(false)

// 鼠标跟随光斑：hover 时光斑中心跟随指针（CSS 自定义属性承载坐标，
// 不直接写 style 属性，符合样式债门禁；卡片级 passive 监听开销极小）
const spotEl = ref<HTMLElement | null>(null)
let spotFrame = 0
function onSpotEnter(e: MouseEvent) {
  const el = e.currentTarget as HTMLElement
  spotEl.value = el
  el.style.setProperty('--sc-spot-o', '1')
}
function onSpotLeave(e: MouseEvent) {
  const el = e.currentTarget as HTMLElement
  spotEl.value = null
  if (spotFrame) { cancelAnimationFrame(spotFrame); spotFrame = 0 }
  el.style.setProperty('--sc-spot-o', '0')
}
function onSpotMove(e: MouseEvent) {
  const el = e.currentTarget as HTMLElement
  if (spotEl.value !== el) return
  if (spotFrame) return
  spotFrame = requestAnimationFrame(() => {
    spotFrame = 0
    const r = el.getBoundingClientRect()
    el.style.setProperty('--sc-spot-x', String(e.clientX - r.left))
    el.style.setProperty('--sc-spot-y', String(e.clientY - r.top))
  })
}

const clickable = computed(() =>
  props.clickable === true || (props.clickable !== false && props.mode !== 'strip')
)
const contentRating = computed(() => props.scene.rating || (props.scene.mature ? 'R18' : 'All'))
const thumbId = computed(() => String(props.scene.id || '').toLowerCase().replace(/[^a-z0-9_-]/g, ''))
const thumbSrc = computed(() => {
  const v = props.imgVersion ?? ''
  return `/scene-showcase/thumbs/${thumbId.value}.jpg${v ? '?v=' + encodeURIComponent(String(v)) : ''}`
})
watch(thumbSrc, () => {
  thumbLoaded.value = false
  thumbFailed.value = false
})
const tags = computed(() => {
  const limit = props.mode === 'strip' ? 2 : 3
  const list = (props.scene.tags || []).filter(t => !TAG_BLOCKLIST.includes(t)).slice(0, limit)
  if (props.scene.emotion && list.length < limit) list.push(props.scene.emotion)
  return list
})
const metaText = computed(() =>
  props.meta ?? [props.scene.season || '', props.scene.weather || ''].filter(Boolean).join(' · ')
)
onUnmounted(() => { if (spotFrame) cancelAnimationFrame(spotFrame) })
</script>
