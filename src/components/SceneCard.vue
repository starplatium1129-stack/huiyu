<template>
  <div
    class="sc"
    :class="[`sc-${mode}`, { 'sc-static': !clickable, 'sc-complete-preview': completePreview }]"
    :data-rating="contentRating"
    :role="clickable ? 'button' : undefined"
    :tabindex="clickable ? 0 : undefined"
    @click="clickable && emit('pick', scene)"
    @keydown="onCardKeydown"
  >
    <div class="sc-band">
      <div v-if="thumbId && thumbSrc" class="sc-thumb-skeleton" :class="{ visible: !thumbLoaded && !thumbFailed }" aria-hidden="true"></div>
      <img
        v-if="thumbId && thumbSrc"
        v-bind="thumbImage"
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
import { useRuntimeImage } from '@/composables/useRuntimeImage'
import SensitivePreviewVeil from '@/components/visual/SensitivePreviewVeil.vue'

import { computed } from 'vue'

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
  completePreview?: boolean
  meta?: string
  imgVersion?: string | number
}>(), {
  mode: 'grid',
  clickable: undefined,
  suppressTags: false,
  completePreview: false,
})

const emit = defineEmits<{ pick: [scene: SceneCardScene] }>()

const TAG_BLOCKLIST = ['official_cg', 'visual_audited']

const clickable = computed(() =>
  props.clickable === true || (props.clickable !== false && props.mode !== 'strip')
)
function onCardKeydown(event: KeyboardEvent) {
  if (!clickable.value || event.target !== event.currentTarget || event.defaultPrevented || event.isComposing || (event.key !== 'Enter' && event.key !== ' ')) return
  event.preventDefault()
  emit('pick', props.scene)
}
const contentRating = computed(() => props.scene.rating || (props.scene.mature ? 'R18' : 'All'))
const thumbId = computed(() => String(props.scene.id || '').toLowerCase().replace(/[^a-z0-9_-]/g, ''))
const { image: thumbImage, src: thumbSrc, loaded: thumbLoaded, failed: thumbFailed } = useRuntimeImage(() => {
  const v = props.imgVersion ?? ''
  return `/scene-showcase/thumbs/${thumbId.value}.jpg${v ? '?v=' + encodeURIComponent(String(v)) : ''}`
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
</script>
<style src="@/assets/css/scene-card.css"></style>
