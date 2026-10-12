<template>
  <section v-if="scenes.length" class="art-journal container" aria-labelledby="journal-title" data-reveal>
    <header class="journal-heading tw:flex tw:justify-between tw:gap-s-5 tw:mb-s-4">
      <div><span class="eyebrow">CG JOURNAL / 画里的日常</span><h2 id="journal-title">在喜欢的世界，多停留一会。</h2></div>
      <RouterLink to="/showcase" class="journal-more">翻阅参考画册 <ArchiveIcon name="image" /></RouterLink>
    </header>
    <div class="journal-spread tw:grid">
      <RuntimeImage v-for="(scene, index) in scenes.slice(0, 3)" :key="scene.id" :src="'/scene-showcase/images/' + scene.id + '.jpg'" v-slot="{ image, failed }">
      <RouterLink class="journal-entry" :class="{ lead: index === 0 }" :to="(failed ? '/scene-explorer?scene=' : '/showcase?scene=') + encodeURIComponent(scene.id)">
        <div class="journal-art tw:relative tw:overflow-hidden tw:rounded-xl"><img v-if="image.src && !failed" v-bind="image" :alt="scene.title" width="1024" height="1344" loading="lazy" decoding="async" /><span v-else class="journal-missing tw:flex tw:h-full tw:flex-col tw:items-center tw:justify-center tw:gap-s-2 tw:p-s-4 tw:text-secondary tw:text-body-sm tw:text-center">样张暂未连接<span>先看看这一幕的故事与设定</span></span></div>
        <div class="journal-caption tw:min-w-0"><span class="journal-category tw:text-accent tw:text-label-xs">{{ scene.category || '角色片刻' }}</span><h3>{{ scene.title }}</h3><p>{{ excerpt(scene.story) }}</p><span class="journal-read tw:inline-flex tw:items-center tw:gap-s-3 tw:text-label-sm tw:text-secondary">{{ failed ? '查看场景设定' : '走进这一幕' }} <span aria-hidden="true">↗</span></span></div>
      </RouterLink>
      </RuntimeImage>
    </div>
  </section>
</template>
<script setup lang="ts">
import RuntimeImage from '@/components/visual/RuntimeImage.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
defineProps<{ scenes: Array<{ id: string; title?: string; story?: string; category?: string }> }>()
function excerpt(story?: string) { return (story || '一些想留下的光影，一段只属于角色的时光。').replace(/^【[^】]+】/, '').slice(0, 84) }
</script>
<style scoped>
@reference "../../assets/css/tailwind.css";
.art-journal { margin-block: var(--s-7); }
.journal-heading { align-items: end; }
.journal-heading h2 { font: 500 var(--fs-title-sm)/var(--lh-label) var(--font-serif); margin:var(--s-2) 0 0; }
.journal-heading .eyebrow { @apply tw:text-label-xs; letter-spacing: .16em; @apply tw:text-muted; }
.journal-more { @apply tw:inline-flex tw:items-center tw:gap-s-2 tw:min-h-[44px] tw:text-label tw:text-secondary tw:whitespace-nowrap; }
.journal-spread { grid-template-columns: 1.2fr 1fr; gap: var(--s-5); }
.journal-entry { @apply tw:grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); @apply tw:items-center tw:gap-s-5 tw:text-primary tw:min-w-0; }
.journal-entry.lead { grid-row: span 2; @apply tw:flex tw:flex-col tw:items-stretch; }
.journal-art { background: var(--bg-surface); aspect-ratio: 4 / 5; }
.journal-missing > span { @apply tw:text-label tw:text-muted; }
.lead .journal-art { aspect-ratio: 4 / 3; }
.journal-art img { @apply tw:w-full tw:h-full tw:object-cover; object-position: center 32%; }
.journal-caption h3 { margin-block: var(--s-2); font: 500 var(--fs-title-sm)/var(--lh-label) var(--font-serif); }
.lead h3 { @apply tw:text-title; }
.journal-caption p { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; @apply tw:overflow-hidden tw:text-label tw:leading-body tw:text-secondary; }
.journal-entry:focus-visible, .journal-more:focus-visible { outline:2px solid var(--accent); outline-offset:4px; border-radius:var(--r-md); }
@media (hover: hover) and (pointer: fine) { .journal-entry:hover .journal-read { text-decoration:underline; text-underline-offset:.25em; } }
@media (max-width: 900px) { .journal-spread { @apply tw:gap-s-5; } .journal-entry { grid-template-columns: minmax(0, 1fr); @apply tw:gap-s-3; } .journal-caption p { -webkit-line-clamp: 2; } }
@media (max-width: 600px) { .art-journal { margin-block: var(--s-7); } .journal-heading { align-items: start; @apply tw:flex-col tw:gap-s-3; } .journal-spread { grid-template-columns: minmax(0, 1fr); } .journal-entry:not(.lead) { grid-template-columns: 112px minmax(0, 1fr); @apply tw:pt-s-5; border-top: 1px solid var(--border-soft); } }
</style>
