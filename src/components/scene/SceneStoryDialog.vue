<template>
  <SceneArtworkViewer ref="viewer" v-model="selectedId" :items="previews" @after-close="releaseStory">
    <template v-if="displayedScene" #info>
      <div class="viewer-meta">{{ sceneCharacterName(displayedScene) }} · {{ sceneSeasonLabel(displayedScene.season) }} · {{ sceneTimeLabel(displayedScene.timeOfDay) }} · {{ displayedScene.emotion }}</div>
      <section class="viewer-section"><h3>场景故事</h3><p class="viewer-story scene-story">{{ displayedScene.story || '' }}</p></section>
      <div class="viewer-actions">
        <RouterLink class="btn btn-primary" :to="'/prompt-builder?scene=' + encodeURIComponent(displayedScene.id)"><ArchiveIcon name="spark" />开始绘制这一幕</RouterLink>
        <RouterLink class="btn btn-ghost" :to="quickCreateUrl(displayedScene.id)"><ArchiveIcon name="lightning" />快速出图</RouterLink>
      </div>
    </template>
  </SceneArtworkViewer>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import SceneArtworkViewer from './SceneArtworkViewer.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { sceneCharacterName, sceneSeasonLabel, sceneTimeLabel, type ExplorerScene } from '@/composables/scene/sceneExplorerPresentation'
import { quickCreateUrl } from '@/utils/quickCreate'

const props = withDefaults(defineProps<{ scenes?: ExplorerScene[] }>(), { scenes: () => [] })
const emit = defineEmits<{ 'after-close': [] }>()
const scene = defineModel<ExplorerScene | null>({ required: true })
const viewer = ref<InstanceType<typeof SceneArtworkViewer> | null>(null)
const displayedScene = ref(scene.value)
const openingScene = ref(scene.value)
watch([scene, () => props.scenes], ([value, items], previous) => {
  if (openingScene.value) openingScene.value = items.find(item => item.id === openingScene.value?.id) ?? openingScene.value
  if (!value) return
  const current = items.find(item => item.id === value.id) ?? value
  if (!previous?.[0] || openingScene.value?.id === value.id) openingScene.value = current
  displayedScene.value = current
}, { immediate: true, flush: 'sync' })
const available = computed(() => {
  // An out-of-filter entry remains reachable after browsing the next scene.
  const extras = [openingScene.value, displayedScene.value].filter((item, index, items): item is ExplorerScene =>
    !!item && !props.scenes.some(scene => scene.id === item.id) && items.findIndex(scene => scene?.id === item.id) === index)
  return extras.length ? [...extras, ...props.scenes] : props.scenes
})
const selectedId = computed({
  get: () => scene.value?.id ?? null,
  set: id => { scene.value = id ? available.value.find(item => item.id === id) ?? null : null },
})
const previews = computed(() => available.value.map(item => {
  const id = item.id.toLowerCase().replace(/[^a-z0-9_-]/g, '')
  return { id: item.id, title: item.title || '未命名场景', src: `/scene-showcase/images/${id}.jpg`,
    previewSrc: `/scene-showcase/thumbs/${id}.jpg` }
}))
function releaseStory() {
  if (scene.value) return
  displayedScene.value = null; openingScene.value = null
  emit('after-close')
}
function capture(event: MouseEvent) {
  const card = (event.target as HTMLElement).closest<HTMLElement>('.sc, .inspiration-deck-image')
  viewer.value?.capture(card?.querySelector<HTMLImageElement>('img') ?? null)
}
defineExpose({ capture })
</script>

<style scoped>
.scene-story { white-space:pre-line; }
</style>
