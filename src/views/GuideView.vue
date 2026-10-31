<script setup lang="ts">
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import CardEdgeLight from '@/components/visual/CardEdgeLight.vue'
import createOriginal from '@/assets/illustrations/atelier-create-spot.webp'
import { useThemeIllustration } from '@/composables/useThemeIllustration'

const createArt = useThemeIllustration(createOriginal, 'draw')

const steps = [
  {
    title: '挑选灵感场景',
    icon: 'spark' as const,
    paragraphs: [
      '挑选剧情设定、构图与光影风格。',
    ],
    links: [{ to: '/scene-explorer', label: '灵感场景' }, { to: '/showcase', label: '参考画册' }],
  },
  {
    title: '载入场景与角色',
    icon: 'image' as const,
    paragraphs: [
      '一键载入工作台，角色、服装与描述自动同步。',
    ],
    links: [{ to: '/popular-scenes', label: '角色场景' }],
  },
  {
    title: '生成画面',
    icon: 'wand' as const,
    paragraphs: [
      '点击「生成图片」，画布实时呈现成片过程。',
    ],
    links: [{ to: '/prompt-builder', label: '进入工作台' }],
    primary: true,
  },
  {
    title: '作品入册',
    icon: 'gallery' as const,
    paragraphs: [
      '成片一键存入作品册，支持按角色整理与本地导出。',
    ],
    links: [{ to: '/gallery', label: '我的作品' }],
  },
]
</script>

<template>
  <article class="page page-narrow guide-page" aria-labelledby="guide-title">
    <RouterLink class="nav-back" to="/">回到首页</RouterLink>
    <header class="page-header">
      <div>
        <p class="page-kicker">使用指南</p>
        <h1 id="guide-title" class="page-title">创作你的第一张 CG</h1>
        <p class="page-subtitle">选场景、定角色、生成入册。</p>
      </div>
      <img class="guide-cover-art" :src="createArt" alt="" width="512" height="512" decoding="async" draggable="false" />
    </header>

    <section class="guide-preparation" data-route-arrive aria-labelledby="guide-preparation-title">
      <span class="guide-preparation-icon" aria-hidden="true"><ArchiveIcon name="gear" /></span>
      <div>
        <h2 id="guide-preparation-title">确认绘图服务</h2>
        <p>生成前请在控制面板确认绘图环境就绪。</p>
        <RouterLink class="btn btn-ghost" to="/control#control-setup"><span class="studio-control-label">配置模型与服务</span><ArchiveIcon name="chevron-down" class="guide-link-arrow" /></RouterLink>
      </div>
    </section>

    <ol class="guide-steps" role="list" aria-label="从灵感到作品的四步">
      <li v-for="(step, index) in steps" :key="step.title" class="guide-step">
        <span class="guide-step-number" aria-hidden="true">{{ String(index + 1).padStart(2, '0') }}</span>
        <section class="guide-step-card" :aria-labelledby="`guide-step-${index}`">
          <div class="guide-step-heading"><h2 :id="`guide-step-${index}`">{{ step.title }}</h2><span class="guide-step-icon" aria-hidden="true"><ArchiveIcon :name="step.icon" /></span></div>
          <p v-for="paragraph in step.paragraphs" :key="paragraph">{{ paragraph }}</p>
          <div class="guide-links"><RouterLink v-for="link in step.links" :key="link.to" :to="link.to" class="btn" :class="step.primary ? 'btn-primary' : 'btn-ghost'"><span class="studio-control-label">{{ link.label }}</span><ArchiveIcon name="chevron-down" class="guide-link-arrow" /></RouterLink></div>
          <CardEdgeLight />
        </section>
      </li>
    </ol>
  </article>
</template>

<style scoped>
.guide-page { --page-max:860px; --guide-duration:var(--motion-route); --guide-lift:-4px; --guide-tilt:-8deg; }
.guide-page .page-header { display:grid; grid-template-columns:minmax(0,1fr) 144px; align-items:center; gap:var(--s-5); padding:var(--s-5) 0; margin-bottom:var(--s-5); text-align:left; }
.guide-page .page-title { margin:var(--s-2) 0 0; font:600 clamp(26px,2.6vw,36px)/var(--lh-tight) var(--font-serif); letter-spacing:0; }
.guide-cover-art { display:block; width:144px; height:144px; object-fit:contain; pointer-events:none; }
.guide-preparation { display:grid; grid-template-columns:auto minmax(0,1fr); align-items:start; gap:var(--s-4); padding:var(--s-5); border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--bg-surface); box-shadow:inset 0 1px 0 var(--glass-highlight); }
.guide-preparation-icon,.guide-step-icon { display:grid; place-items:center; flex:none; width:40px; height:40px; border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--bg-elevated); color:var(--accent); }
.guide-preparation-icon .archive-icon,.guide-step-icon .archive-icon { width:20px; height:20px; }
.guide-page h2 { margin:0; color:var(--text-primary); font-size:var(--fs-title-sm); line-height:var(--lh-label); }
.guide-page p { color:var(--text-secondary); line-height:var(--lh-loose); }
.guide-preparation p { margin:var(--s-2) 0 var(--s-3); }
.guide-steps { display:grid; gap:var(--s-4); margin:var(--s-5) 0 0; padding:0; list-style:none; }
.guide-step { position:relative; display:grid; grid-template-columns:40px minmax(0,1fr); align-items:start; gap:var(--s-4); }
.guide-step:not(:last-child)::before { content:''; position:absolute; left:19px; top:48px; bottom:calc(-1 * var(--s-4)); width:1px; background:var(--border-soft); }
.guide-step-number { display:grid; place-items:center; width:40px; height:40px; margin-top:var(--s-4); border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--bg-surface); color:var(--accent); font:500 var(--fs-body)/1 var(--font-serif); }
.guide-step-card { position:relative; isolation:isolate; min-width:0; padding:var(--s-5); border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--bg-surface); box-shadow:inset 0 1px 0 var(--glass-highlight); }
.guide-step-heading { display:flex; align-items:center; justify-content:space-between; gap:var(--s-3); margin-bottom:var(--s-3); }
.guide-step-heading h2 { font-family:var(--font-serif); }
.guide-step-icon { width:32px; height:32px; background:var(--accent-soft); border-color:transparent; transition:transform var(--guide-duration) var(--spring-soft); }
.guide-step-card p + p { margin-top:var(--s-2); }
.guide-links { display:flex; flex-wrap:wrap; gap:var(--s-2); margin-top:var(--s-4); }
.guide-page .btn { min-height:var(--control-height); border-radius:var(--r-md); }
.guide-page .btn:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
.guide-link-arrow { width:16px; height:16px; transform:rotate(-90deg); }
@media (hover:hover) and (pointer:fine) { .guide-step-card:hover:not(:focus-within) .guide-step-icon { transform:translateY(var(--guide-lift)) rotate(var(--guide-tilt)); } }
@media (max-width:768px) {
  .guide-page .page-header { grid-template-columns:minmax(0,1fr) 88px; gap:var(--s-3); padding:var(--s-4) 0; }
  .guide-cover-art { width:88px; height:88px; }
  .guide-step { gap:var(--s-3); grid-template-columns:32px minmax(0,1fr); }
  .guide-step-number { width:32px; height:32px; }
  .guide-step:not(:last-child)::before { left:15px; top:56px; }
  .guide-step-card { padding:var(--s-4); }
  .guide-preparation { padding:var(--s-4); gap:var(--s-3); }
}
@media (pointer:coarse) { .guide-page .btn { min-height:44px; } }
@media (prefers-reduced-motion:reduce) { :root:not([data-motion='full']) .guide-page { --guide-duration:0s; --guide-lift:0px; --guide-tilt:0deg; } }
:root:is([data-motion='reduce'],[data-motion='reduced']) .guide-page { --guide-duration:0s; --guide-lift:0px; --guide-tilt:0deg; }
@media (forced-colors:active) { .guide-step-card,.guide-preparation,.guide-step-number { border-color:CanvasText; } .guide-page .btn:focus-visible { outline:2px solid Highlight; } }
</style>
