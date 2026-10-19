<template>
  <div
    class="sc"
    :class="[`sc-${mode}`, { 'sc-static': !clickable, 'sc-complete-preview': completePreview }]"
    :style="previewStyle"
    :data-rating="contentRating"
    @click="onCardClick"
  >
    <div class="sc-band">
      <div v-if="thumbId && thumbSrc" class="sc-thumb-skeleton" :class="{ visible: !thumbLoaded && !thumbFailed }" aria-hidden="true"></div>
      <img
        v-if="thumbId && thumbSrc"
        v-bind="{ ...thumbImage, onLoad: measurePreview }"
        class="sc-thumb"
        :class="{ 'sc-thumb-r18': contentRating === 'R18', 'sc-thumb-missing': thumbFailed, 'sc-thumb-ready': thumbLoaded }"
        alt=""
        loading="lazy"
        decoding="async"
        fetchpriority="auto"
      />
      <SensitivePreviewVeil v-if="contentRating === 'R18' && thumbSrc && !thumbFailed"
        :src="thumbSrc" :crossorigin="thumbImage.crossorigin" />
      <span v-if="thumbFailed || !thumbId || !thumbSrc" class="sc-preview-unavailable">{{ !thumbSrc && thumbId ? '图片服务暂未连接 · 场景可用' : '样张暂缺 · 场景可用' }}</span>
      <span v-if="thumbId" class="sc-id">{{ archiveCode }}</span>
      <span v-if="contentRating === 'R18'" class="sc-badge sc-rating r18">R18</span>
      <span v-else-if="contentRating === 'R15'" class="sc-badge sc-rating r15">R15</span>
      <span v-if="mode === 'grid'" class="sc-cat">{{ scene.category || '场景' }}</span>
      <slot name="band" :scene="scene" />
      <button v-if="clickable" class="sc-pick" type="button"
        :aria-label="ariaLabel || '查看场景：' + (scene.title || '未命名')" :aria-expanded="ariaExpanded"
        @click.stop="emit('pick', scene)" />
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
    <CardEdgeLight v-if="clickable" />
  </div>
</template>

<script setup lang="ts">
import { useRuntimeImage } from '@/composables/useRuntimeImage'
import SensitivePreviewVeil from '@/components/visual/SensitivePreviewVeil.vue'
import CardEdgeLight from '@/components/visual/CardEdgeLight.vue'

import { computed, shallowRef, watch } from 'vue'
import { sceneRecommendedSize } from '@/utils/sceneInference'
import { cachedImageDimensions, rememberImageDimensions } from '@/utils/imageDimensions'
import { runtimeResourceIdentity } from '@/platform/runtimeUrl'

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
  mode?: 'grid' | 'strip'
  clickable?: boolean
  suppressTags?: boolean
  completePreview?: boolean
  meta?: string
  imgVersion?: string | number
  thumbUrl?: string
  previewDimensions?: { width: number; height: number }
  ariaLabel?: string
  ariaExpanded?: boolean
}>(), {
  mode: 'grid',
  clickable: undefined,
  suppressTags: false,
  completePreview: false,
  ariaExpanded: undefined,
})

const emit = defineEmits<{ pick: [scene: SceneCardScene] }>()

const TAG_BLOCKLIST = ['official_cg', 'visual_audited']

const clickable = computed(() =>
  props.clickable === true || (props.clickable !== false && props.mode !== 'strip')
)
function onCardClick(event: MouseEvent) {
  if (!clickable.value || event.defaultPrevented || !(event.target instanceof Element)
    || event.target.closest('button,a,input,textarea,select,summary,details,[role="button"]')) return
  emit('pick', props.scene)
}
const contentRating = computed(() => props.scene.rating || (props.scene.mature ? 'R18' : 'All'))
const thumbId = computed(() => String(props.scene.id || '').toLowerCase().replace(/[^a-z0-9_-]/g, ''))
const archiveCode = computed(() => thumbId.value.replace(/^sc(?=\d)/, 'sc-').toUpperCase())
const { image: thumbImage, src: thumbSrc, loaded: thumbLoaded, failed: thumbFailed } = useRuntimeImage(() => {
  if (props.thumbUrl) return props.thumbUrl
  const v = props.imgVersion ?? ''
  return `/scene-showcase/thumbs/${thumbId.value}.jpg${v ? '?v=' + encodeURIComponent(String(v)) : ''}`
})
const naturalDimensions = shallowRef(cachedImageDimensions(thumbSrc.value))
watch([thumbSrc, runtimeResourceIdentity], ([src]) => {
  naturalDimensions.value = cachedImageDimensions(src)
}, { flush: 'sync' })
const previewStyle = computed(() => {
  if (!props.completePreview) return undefined
  const [width, height] = sceneRecommendedSize(props.scene).split('x').map(Number)
  const size = naturalDimensions.value || props.previewDimensions
  return { '--scene-preview-ratio': size ? size.width / size.height : width / height }
})
function measurePreview(event: Event) {
  if (!thumbImage.value.onLoad(event)) return
  const image = event.target as HTMLImageElement
  const size = rememberImageDimensions(thumbSrc.value, image.naturalWidth, image.naturalHeight)
  if (size) naturalDimensions.value = size
}
const tags = computed(() => {
  const limit = props.mode === 'strip' ? 2 : 3
  const list = (props.scene.tags || []).filter(t => !TAG_BLOCKLIST.includes(t)).slice(0, limit)
  if (props.scene.emotion && list.length < limit) list.push(props.scene.emotion)
  return list
})
const metaText = computed(() =>
  props.meta ?? [props.scene.season || '', props.scene.weather || ''].filter(Boolean).join(' · ')
)
</script>
<style src="@/assets/css/scene-card.css"></style>
