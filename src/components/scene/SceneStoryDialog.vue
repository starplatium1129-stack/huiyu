<template>
  <Teleport to="body">
    <FluidTransition @after-leave="releaseStory">
      <div v-show="scene" ref="drawerEl" class="story-drawer" role="dialog" aria-modal="true"
        :aria-hidden="!scene" aria-label="场景故事" @click.self="scene = null">
        <div v-if="displayedScene" class="story-card">
          <div class="story-art" aria-label="场景完整作品">
            <SceneCard :scene="displayedScene" mode="grid" :clickable="false" completePreview suppressTags />
          </div>
          <div class="story-copy">
            <div class="story-card-head">
              <div><span class="scene-chapter">STORY / 场景故事</span><h3>{{ displayedScene.title }}</h3></div>
              <button class="btn btn-ghost btn-sm btn-icon" type="button" aria-label="关闭故事" @click="scene = null"><ArchiveIcon name="close" /></button>
            </div>
            <div class="story-meta">{{ sceneCharacterName(displayedScene) }} · {{ sceneSeasonLabel(displayedScene.season) }} · {{ sceneTimeLabel(displayedScene.timeOfDay) }} · {{ displayedScene.emotion }}</div>
            <div class="story-body">{{ displayedScene.story || '' }}</div>
            <div class="story-actions">
              <RouterLink class="btn btn-primary" :to="'/prompt-builder?scene=' + encodeURIComponent(displayedScene.id)"><ArchiveIcon name="spark" /> 开始绘制这一幕</RouterLink>
              <RouterLink class="btn btn-ghost" :to="quickCreateUrl(displayedScene.id)"><ArchiveIcon name="lightning" /> 快速出图</RouterLink>
            </div>
          </div>
        </div>
      </div>
    </FluidTransition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import SceneCard from '@/components/SceneCard.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import FluidTransition from '@/components/visual/FluidTransition.vue'
import { useFocusTrap } from '@/composables/useFocusTrap'
import { sceneCharacterName, sceneSeasonLabel, sceneTimeLabel, type ExplorerScene } from '@/composables/scene/sceneExplorerPresentation'
import { quickCreateUrl } from '@/utils/quickCreate'

const scene = defineModel<ExplorerScene | null>({ required: true })
const drawerEl = ref<HTMLElement | null>(null)
// Retain the last artwork and story until the leave transition finishes.
const displayedScene = ref(scene.value)
watch(scene, value => { if (value) displayedScene.value = value }, { flush: 'sync' })
function releaseStory() {
  // A reversed leave still belongs to the newly opened story.
  if (!scene.value) displayedScene.value = null
}
useFocusTrap(drawerEl, () => scene.value !== null, { onEscape: () => { scene.value = null } })
</script>

<style scoped>
.scene-chapter { display:block; margin-bottom:var(--s-2); color:var(--text-muted); font:500 var(--fs-label-xs)/var(--lh-label) var(--font-mono); letter-spacing:.14em; }
.story-drawer { position:fixed; inset:0; z-index:var(--z-overlay); display:flex; align-items:center; justify-content:center; padding:var(--s-5); background:var(--art-backdrop); backdrop-filter:blur(6px); }
.story-card { display:grid; grid-template-columns:minmax(0,1.2fr) minmax(300px,.8fr); width:min(1120px,100%); max-height:calc(100dvh - 2 * var(--s-5)); overflow:auto; overscroll-behavior:contain; border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--bg-surface); box-shadow:var(--shadow-lg); }
.story-art { display:grid; align-content:center; min-width:0; padding:var(--s-4); background:var(--art-stage); }
.story-art :deep(.sc) { background:transparent; border:0; border-radius:0; box-shadow:none; content-visibility:visible; cursor:default; }
.story-art :deep(.sc::after),.story-art :deep(.sc-band::after),.story-art :deep(.sc-body),.story-art :deep(.sc-id),.story-art :deep(.sc-cat) { display:none; }
.story-art :deep(.sc-band) { display:flex; align-items:center; justify-content:center; padding:0; background:transparent; }
.story-art :deep(.sc-thumb) { width:auto; max-width:100%; height:auto; max-height:calc(100dvh - 6 * var(--s-5)); border:1px solid var(--art-frame-line); border-radius:var(--r-sm); }
.story-copy { display:flex; flex-direction:column; gap:var(--s-3); min-width:0; padding:var(--s-5); }
.story-card-head { display:flex; align-items:flex-start; justify-content:space-between; gap:var(--s-3); }
.story-card-head h3 { margin:0; color:var(--text-primary); font:600 clamp(22px,2vw,30px)/1.35 var(--font-display); letter-spacing:-.03em; }
.story-card-head > .btn { flex:0 0 auto; }
.story-meta { color:var(--text-muted); font-size:var(--fs-label-sm); }
.story-body { color:var(--text-secondary); font-size:var(--fs-body); line-height:var(--lh-loose); white-space:pre-line; }
.story-actions { display:grid; gap:var(--s-2); margin-top:auto; padding-top:var(--s-4); }
.story-actions .btn { justify-content:center; }
@media (max-width:900px) {
  .story-card { grid-template-columns:minmax(0,1fr) minmax(260px,1fr); }
  .story-copy { padding:var(--s-4); }
}
@media (max-width:700px) {
  .story-drawer { padding:var(--s-3); }
  .story-card { grid-template-columns:minmax(0,1fr); }
  .story-art :deep(.sc-thumb) { max-height:42dvh; }
}
:global(:root:is([data-fluid-effects='low'],[data-reduced-glass='true'])) .story-drawer { background:var(--bg-surface); backdrop-filter:none; }
@media (prefers-reduced-transparency:reduce),(prefers-contrast:more) { .story-drawer { background:var(--bg-surface); backdrop-filter:none; } }
@media (forced-colors:active) { .story-drawer { background:Canvas; backdrop-filter:none; } }
</style>
