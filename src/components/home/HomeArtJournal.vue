<template>
  <section v-if="scenes.length" class="art-journal container" aria-labelledby="journal-title" data-reveal>
    <header class="journal-heading">
      <div><span class="eyebrow">CG JOURNAL / 画里的日常</span><h2 id="journal-title">在喜欢的世界，多停留一会。</h2></div>
      <RouterLink to="/showcase" class="journal-more">翻阅参考画册 <ArchiveIcon name="image" /></RouterLink>
    </header>
    <div class="journal-spread">
      <RouterLink v-for="(scene, index) in scenes.slice(0, 3)" :key="scene.id" class="journal-entry" :class="{ lead: index === 0 }" :to="(missingScenes.has(scene.id) ? '/scene-explorer?scene=' : '/showcase?scene=') + encodeURIComponent(scene.id)">
        <div class="journal-art"><img :crossorigin="runtimeResourceCors()" v-if="!missingScenes.has(scene.id)" @error="missingScenes.add(scene.id)" :src="resolveRuntimeUrl('/scene-showcase/images/' + scene.id + '.jpg')" :alt="scene.title" width="1024" height="1344" loading="lazy" decoding="async" /><span v-else class="journal-missing">样张暂未连接<span>先看看这一幕的故事与设定</span></span></div>
        <div class="journal-caption"><span class="journal-category">{{ scene.category || '角色片刻' }}</span><h3>{{ scene.title }}</h3><p>{{ excerpt(scene.story) }}</p><span class="journal-read">{{ missingScenes.has(scene.id) ? '查看场景设定' : '走进这一幕' }} <span aria-hidden="true">↗</span></span></div>
      </RouterLink>
    </div>
  </section>
</template>
<script setup lang="ts">
import { resolveRuntimeUrl, runtimeResourceCors } from '@/platform/runtimeUrl'

import { ref } from 'vue'
const missingScenes = ref(new Set<string>())
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
defineProps<{ scenes: Array<{ id: string; title?: string; story?: string; category?: string }> }>()
function excerpt(story?: string) { return (story || '一些想留下的光影，一段只属于角色的时光。').replace(/^【[^】]+】/, '').slice(0, 84) }
</script>
<style scoped>
.art-journal { margin-block: var(--s-8); }
.journal-heading { display: flex; justify-content: space-between; align-items: end; gap: var(--s-5); margin-bottom: var(--s-6); }
.journal-heading h2 { font: 500 clamp(1.5rem, 2.4vw, 2rem)/1.4 var(--font-serif); margin: 0; }
.journal-heading .eyebrow { font-size: var(--fs-label-xs); letter-spacing: .16em; color: var(--text-muted); }
.journal-more { display: inline-flex; align-items: center; gap: var(--s-2); font-size: var(--fs-label); color: var(--text-secondary); white-space: nowrap; }
.journal-spread { display: grid; grid-template-columns: 1.2fr 1fr; gap: var(--s-5) var(--s-7); }
.journal-entry { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: center; gap: var(--s-5); color: var(--text-primary); min-width: 0; }
.journal-entry.lead { grid-row: span 2; display: flex; flex-direction: column; align-items: stretch; }
.journal-art { position: relative; overflow: hidden; border-radius: var(--r-xl); background: var(--bg-surface); aspect-ratio: 4 / 5; }
.journal-missing { display: flex; height: 100%; flex-direction: column; align-items: center; justify-content: center; gap: var(--s-2); padding: var(--s-4); color: var(--text-secondary); font-size: var(--fs-body-sm); text-align: center; }
.journal-missing > span { font-size: var(--fs-label); color: var(--text-muted); }
.lead .journal-art { aspect-ratio: 4 / 3; }
.journal-art img { width: 100%; height: 100%; object-fit: cover; object-position: center 32%; transition: transform .7s cubic-bezier(.22,1,.36,1); }
.journal-caption { min-width: 0; }
.journal-category { color: var(--accent); font-size: var(--fs-label-xs); }
.journal-caption h3 { margin-block: var(--s-2); font: 500 var(--fs-title-sm)/var(--lh-label) var(--font-serif); }
.lead h3 { font-size: var(--fs-title); }
.journal-caption p { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; font-size: var(--fs-label); line-height: 1.9; color: var(--text-muted); }
.journal-read { display: inline-flex; align-items: center; gap: var(--s-3); font-size: var(--fs-label-sm); color: var(--text-secondary); }
.journal-read span { transition: transform .4s var(--ease-out); }
@media (hover: hover) { .journal-entry:hover img { transform: scale(1.035); } .journal-entry:hover .journal-read span { transform: translate(3px,-3px); } }
@media (max-width: 900px) { .journal-spread { gap: var(--s-5); } .journal-entry { grid-template-columns: minmax(0, 1fr); gap: var(--s-3); } .journal-caption p { -webkit-line-clamp: 2; } }
@media (max-width: 600px) { .art-journal { margin-block: var(--s-7); } .journal-heading { align-items: start; flex-direction: column; gap: var(--s-3); } .journal-spread { grid-template-columns: minmax(0, 1fr); } .journal-entry:not(.lead) { grid-template-columns: 112px minmax(0, 1fr); padding-top: var(--s-5); border-top: 1px solid var(--border-soft); } }
@media (prefers-reduced-motion: reduce) { .journal-art img, .journal-read span { transition: none; } }
</style>
