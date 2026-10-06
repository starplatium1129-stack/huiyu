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
const scene = defineModel<ExplorerScene | null>({ required: true })
const viewer = ref<InstanceType<typeof SceneArtworkViewer> | null>(null)
const displayedScene = ref(scene.value)
watch(scene, value => { if (value) displayedScene.value = value }, { flush: 'sync' })
const available = computed(() => {
  const selected = displayedScene.value
  return selected && !props.scenes.some(item => item.id === selected.id) ? [selected, ...props.scenes] : props.scenes
})
const selectedId = computed({
  get: () => scene.value?.id ?? null,
  set: id => { scene.value = id ? available.value.find(item => item.id === id) ?? null : null },
})
const previews = computed(() => available.value.map(item => {
  const id = item.id.toLowerCase().replace(/[^a-z0-9_-]/g, '')
  return { id: item.id, title: item.title || '未命名场景', src: `/scene-showcase/images/${id}.jpg`,
    previewSrc: `/scene-showcase/thumbs/${id}.jpg`, restricted: (item.rating || (item.mature ? 'R18' : 'All')) === 'R18' }
}))
function releaseStory() { if (!scene.value) displayedScene.value = null }
function capture(event: MouseEvent) {
  const card = (event.target as HTMLElement).closest<HTMLElement>('.sc, .inspiration-deck-image')
  viewer.value?.capture(card?.dataset.rating === 'R18' ? null : card?.querySelector<HTMLImageElement>('img') ?? null)
}
defineExpose({ capture })
</script>

<style scoped>
.scene-story { white-space:pre-line; }
</style>
