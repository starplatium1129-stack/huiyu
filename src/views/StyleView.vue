<template>
  <article class="page style-page" style="--page-max:1120px">
    <a class="nav-back" href="/" @click.prevent="$router.push('/')">← 回首页</a>
    <ArchivePageHero chapter="04" section="Visual grammar" shape="spark" label="色彩与光线" caption="PALETTE 04 / 08" compact>
      <div class="page-kicker">Art direction</div>
      <h1 class="title">画风</h1>
      <p class="subtitle">为喜欢的角色，挑一束恰好的光。</p>
    </ArchivePageHero>
    <CreativeLibraryNav />

    <header class="style-chapter" data-reveal>
      <div><span class="style-eyebrow">光色手帖 / 01—06</span><h2>同一种心动，不同的色调。</h2></div>
      <p>翻看画册里的氛围参考，从光线、色彩与留白中，找到这一幕的心情。</p>
    </header>
    <div class="mood-grid style-mood-grid" data-reveal data-reveal-delay="1">
      <article v-for="m in MOODS" :key="m.id" class="style-mood-card">
        <RouterLink class="style-sample" :class="{ 'is-unavailable': !loading && !available.has(m.sceneId) }" :to="'/showcase?scene=' + m.sceneId" :aria-label="'查看' + m.name + '氛围参考'">
          <img :crossorigin="runtimeResourceCors()" v-if="available.has(m.sceneId) && !failedSamples.has(m.id)" :src="resolveRuntimeUrl('/scene-showcase/thumbs/' + m.sceneId + '.jpg')" :alt="m.sampleTitle + ' · 氛围参考'" width="560" height="818" loading="lazy" decoding="async" @error="failedSamples.add(m.id)" />
          <span v-else class="style-sample-missing"><ArchiveIcon name="image" /><span>{{ loading ? '正在翻开画册…' : failedSamples.has(m.id) ? '参考图片加载失败' : '氛围参考暂未连接' }}</span><small>仍可选用下方配色</small></span>
        </RouterLink>
        <div class="style-card-body tw:p-s-4">
          <div class="style-card-heading tw:flex tw:items-center tw:justify-between tw:gap-s-2"><h3><ArchiveIcon :name="m.iconName" />{{ m.name }}</h3><span>{{ m.en }}</span></div>
          <p class="style-sample-caption">{{ m.caption }}</p>
          <div class="mood-strip" aria-hidden="true"><span v-for="(color, index) in m.colors" :key="color + index" class="mood-swatch" :style="{ '--swatch': color }"></span></div>
          <div class="style-card-foot tw:mt-s-3 tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-s-2"><span>{{ m.desc }}</span><RouterLink :to="'/prompt-builder?mood=' + encodeURIComponent(m.id)" class="mood-go">用这个调子绘制<ArchiveIcon name="spark" /></RouterLink></div>
        </div>
      </article>
    </div>

    <section class="style-notes" data-reveal>
      <ArchiveIcon name="palette" />
      <div><h2>把色调带进你的故事</h2><p>选用配色后，可在绘制台继续搭配角色、场景与光照。画册样张供氛围参考，下一张画由你的构思决定。</p></div>
      <RouterLink to="/color-script" class="btn btn-ghost">翻开色彩情绪<ArchiveIcon name="palette" /></RouterLink>
    </section>
  </article>
</template>

<script setup lang="ts">
import '@/assets/css/mood.css'
import { resolveRuntimeUrl, runtimeResourceCors } from '@/platform/runtimeUrl'

import { ref } from 'vue'
import CreativeLibraryNav from '@/components/library/CreativeLibraryNav.vue'
import { COLOR_MOODS } from '@/config/promptConstants'
import ArchivePageHero from '@/components/visual/ArchivePageHero.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { useScrollReveal } from '@/composables/useScrollReveal'
import { useMoodReferences } from '@/composables/useMoodReferences'

// Existing All-rated showcase references, reviewed visually for atmosphere.
// The media gateway retains its rating/access checks; missing media stays a placeholder.
const references: Record<string, { sceneId: string; sampleTitle: string; caption: string }> = {
  joy: { sceneId:'sc003', sampleTitle:'只告诉你的天台秘密', caption:'暖金夕照，照亮轻快的日常。' },
  love: { sceneId:'sc002', sampleTitle:'樱花树下的约定', caption:'樱色与柔光，留住欲言又止的心动。' },
  calm: { sceneId:'sc004', sampleTitle:'书架间的偶遇', caption:'窗边的书页，让喧嚣慢慢安静。' },
  sad: { sceneId:'sc007', sampleTitle:'雨声里的正式回答', caption:'蓝灰雨幕，衬出细腻的情绪。' },
  tension: { sceneId:'sc215', sampleTitle:'月光书页里的小小勇气', caption:'紫蓝月光，让明暗藏一点秘密。' },
  warmth: { sceneId:'sc006', sampleTitle:'平安夜的手作礼物', caption:'灯火与暖橙，把陪伴留在画里。' },
}
const MOODS = COLOR_MOODS.map(mood => ({ ...mood, ...references[mood.id]! }))
const { available, loading } = useMoodReferences(MOODS.map(mood => mood.sceneId))
const failedSamples = ref(new Set<string>())
useScrollReveal()
</script>

<style scoped>@reference "../assets/css/tailwind.css";
.style-page { @apply tw:pt-s-5 tw:pb-s-8; }
.style-page :deep(.archive-copy) { padding-block:var(--s-4); }
.style-chapter { @apply tw:flex tw:justify-between; align-items:end; @apply tw:gap-s-5; margin:var(--s-6) 0 var(--s-5); }
.style-eyebrow { @apply tw:text-body-sm tw:text-accent; letter-spacing:.08em; }
.style-chapter h2 { margin:var(--s-2) 0 0; font:500 var(--fs-title)/var(--lh-label) var(--font-serif); }
.style-chapter p { @apply tw:max-w-[340px] tw:text-secondary tw:text-body-sm tw:leading-body; }
.style-mood-grid { grid-template-columns:repeat(3,minmax(0,1fr)); @apply tw:gap-s-5; }
.style-mood-card { @apply tw:min-w-0 tw:overflow-hidden; border:1px solid var(--border-soft); @apply tw:rounded-xl; background:var(--bg-surface); }
.style-sample { @apply tw:block; aspect-ratio:4 / 3; @apply tw:overflow-hidden; background:var(--bg-elevated); }
.style-sample.is-unavailable { aspect-ratio: auto; @apply tw:min-h-[104px]; }
.style-sample.is-unavailable .style-sample-missing { @apply tw:flex-row tw:flex-wrap tw:min-h-[104px]; }
.style-sample img { @apply tw:w-full tw:h-full tw:object-cover; object-position:center 12%; @apply tw:block; transition:transform var(--motion-surface) var(--ease-out); }
.style-sample-missing { @apply tw:h-full tw:p-s-4 tw:flex tw:flex-col tw:items-center tw:justify-center tw:gap-s-2 tw:text-secondary tw:text-center tw:text-body-sm; }
.style-sample-missing .archive-icon { @apply tw:w-[32px] tw:h-[32px]; }
.style-sample-missing small { font-size:inherit; }
.style-card-heading h3 { @apply tw:flex tw:items-center tw:gap-s-2 tw:m-0 tw:text-primary; font:500 var(--fs-title-sm)/var(--lh-label) var(--font-serif); }
.style-card-heading .archive-icon { @apply tw:text-accent; }
.style-card-heading > span { @apply tw:text-muted tw:text-body-sm; }
.style-sample-caption { margin:var(--s-2) 0 var(--s-4); @apply tw:text-secondary tw:text-body-sm tw:leading-body; }
.style-card-body .mood-strip { @apply tw:h-[12px] tw:rounded-xs tw:overflow-hidden; }
.style-card-foot > span { @apply tw:text-muted tw:text-body-sm; }
.mood-go { @apply tw:inline-flex tw:items-center tw:gap-s-1 tw:min-h-[44px] tw:text-accent tw:text-body-sm tw:font-semibold; }
.style-sample:focus-visible, .mood-go:focus-visible { outline:2px solid var(--accent); outline-offset:-3px; @apply tw:rounded-sm; }
.style-notes { @apply tw:flex tw:items-center tw:gap-s-4 tw:mt-s-7 tw:pt-s-5; border-top:1px solid var(--border-soft); }
.style-notes > .archive-icon { @apply tw:w-[28px] tw:h-[28px] tw:text-accent tw:shrink-0; }
.style-notes h2 { margin:0 0 var(--s-2); @apply tw:text-body; }
.style-notes p { @apply tw:text-secondary tw:text-body-sm tw:leading-body; }
.style-notes .btn { @apply tw:shrink-0; }
@media (hover:hover) { .style-sample:hover img { transform:scale(1.035); } .mood-go:hover { text-decoration:underline; text-underline-offset:4px; } }
@media (max-width:900px) { .style-mood-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } .style-chapter { align-items:start; @apply tw:flex-col tw:gap-s-3; } .style-chapter p { max-width:none; } .style-notes { @apply tw:flex-wrap; } }
@media (max-width:540px) { .style-mood-grid { grid-template-columns:minmax(0,1fr); } .style-chapter h2 { @apply tw:text-title-sm; } }
@media (prefers-reduced-motion:reduce) { .style-sample img { transition:none; } }
</style>
