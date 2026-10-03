<template>
  <section v-if="scenes.length" class="art-journal container" aria-labelledby="journal-title" data-reveal>
    <header class="journal-heading"><div><span class="eyebrow">CG JOURNAL / 精选画页</span><h2 id="journal-title">把下一幕，留给想象。</h2></div><RouterLink to="/showcase" class="journal-more">翻阅参考画册 <span aria-hidden="true">↗</span></RouterLink></header>
    <div class="journal-spread">
      <RuntimeImage v-for="scene in scenes" :key="scene.id" :src="'/scene-showcase/images/' + scene.id + '.jpg'" v-slot="{ image, failed }">
        <RouterLink class="journal-entry" :to="(failed ? '/scene-explorer?scene=' : '/showcase?scene=') + encodeURIComponent(scene.id)">
          <div class="journal-art" :style="{ '--journal-ratio': ratioOf(scene) }"><img v-if="image.src && !failed" v-bind="image" :alt="scene.title || '精选场景样张'" loading="lazy" decoding="async" @load="measure(scene.id, $event)" /><span v-else class="journal-missing"><ArchiveIcon name="image" /><span>样张暂未连接</span><span>先看看这一幕的设定</span></span></div>
          <div class="journal-caption"><div><span class="journal-category">{{ scene.category || '角色片刻' }}</span><h3>{{ scene.title }}</h3></div><span class="journal-read">{{ failed ? '查看场景设定' : '走进这一幕' }} <span aria-hidden="true">↗</span></span></div>
        </RouterLink>
      </RuntimeImage>
    </div>
  </section>
</template>
<script setup lang="ts">
import RuntimeImage from '@/components/visual/RuntimeImage.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { ref } from 'vue'
type JournalScene = { id: string; title?: string; category?: string; recommendedSize?: unknown }
defineProps<{ scenes: JournalScene[] }>()
const ratios = ref<Record<string, number>>({})
function ratioOf(scene: JournalScene) {
  if (ratios.value[scene.id]) return ratios.value[scene.id]
  const dimensions = typeof scene.recommendedSize === 'string' ? scene.recommendedSize.match(/(\d+)\s*[x×]\s*(\d+)/i) : null
  return dimensions && Number(dimensions[1]) > 0 && Number(dimensions[2]) > 0 ? Number(dimensions[1]) / Number(dimensions[2]) : .75
}
function measure(id: string, event: Event) {
  const image = event.target as HTMLImageElement
  if (image.naturalWidth && image.naturalHeight) ratios.value[id] = image.naturalWidth / image.naturalHeight
}
</script>
<style scoped>
.art-journal { margin-block: var(--s-6); }
.journal-heading { display: flex; align-items: end; justify-content: space-between; gap: var(--s-5); margin-bottom: var(--s-4); }
.eyebrow { color: var(--text-muted); font: 500 var(--fs-mono-xs)/var(--lh-label) var(--font-mono); letter-spacing: .08em; }
.journal-heading h2 { margin: var(--s-2) 0 0; color: var(--text-primary); font: 600 var(--fs-title)/var(--lh-tight) var(--font-sans); letter-spacing: -.03em; }
.journal-more { display: inline-flex; align-items: center; gap: var(--s-3); min-height: 44px; color: var(--text-secondary); font-size: var(--fs-label-sm); white-space: nowrap; }
.journal-spread { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; gap: var(--workspace-panel-gap); }
.journal-entry { min-width: 0; padding: var(--s-2); border: 1px solid var(--album-edge); border-radius: var(--r-lg); background: var(--album-surface); box-shadow: var(--album-shadow); color: var(--text-primary); }
.journal-art { display: grid; grid-template-rows: minmax(0, 1fr); grid-template-columns: minmax(0, 1fr); place-items: center; aspect-ratio: var(--journal-ratio, .75); overflow: hidden; border-radius: var(--r-sm); background: var(--bg-deep); }
.journal-art img { display: block; min-width: 0; min-height: 0; max-width: 100%; max-height: 100%; width: 100%; height: 100%; object-fit: contain; }
.journal-missing { display: grid; justify-items: center; gap: var(--s-2); padding: var(--s-5); color: var(--text-secondary); font-size: var(--fs-label-sm); text-align: center; }
.journal-missing > .archive-icon { width: 32px; height: 32px; margin-bottom: var(--s-2); }
.journal-missing > span:last-child { color: var(--text-muted); font-size: var(--fs-label-xs); }
.journal-caption { display: flex; align-items: center; justify-content: space-between; gap: var(--s-4); padding: var(--s-4) var(--s-3) var(--s-2); }
.journal-category { color: var(--accent); font-size: var(--fs-label-xs); }
.journal-caption h3 { margin: var(--s-1) 0 0; color: var(--text-primary); font: 600 var(--fs-title-sm)/var(--lh-label) var(--font-sans); }
.journal-read { display: inline-flex; align-items: center; gap: var(--s-3); color: var(--text-secondary); font-size: var(--fs-label-sm); white-space: nowrap; }
.journal-entry:focus-visible, .journal-more:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: var(--r-sm); }
@media (hover: hover) and (pointer: fine) { .journal-entry:hover .journal-read, .journal-more:hover { color: var(--accent); } }
@media (max-width: 900px) { .journal-caption { align-items: start; flex-direction: column; gap: var(--s-2); } }
@media (max-width: 600px) { .journal-heading { align-items: start; gap: var(--s-3); } .journal-heading h2 { font-size: var(--fs-title-sm); } .journal-spread { grid-template-columns: minmax(0, 1fr); } }
</style>