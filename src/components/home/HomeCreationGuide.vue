<template>
  <section class="creation-guide container" aria-labelledby="creation-guide-title">
    <header class="guide-heading tw:flex tw:items-center tw:justify-between tw:gap-s-4 tw:mb-s-4">
      <div><span class="eyebrow">从灵感到作品</span><h2 id="creation-guide-title">第一张 CG，从这里开始</h2></div>
      <RouterLink to="/prompt-builder" class="guide-direct">已有想法？直接绘制 <ArchiveIcon name="spark" /></RouterLink>
    </header>
    <ol class="guide-steps tw:grid tw:p-0 tw:m-0">
      <li><RouterLink to="/scene-explorer"><img class="step-art" :src="inspirationArt" width="512" height="512" alt="" loading="lazy" decoding="async" draggable="false" /><span class="step-number tw:grid tw:h-[40px] tw:rounded-md tw:text-accent">01</span><span><strong>挑一个场景</strong><span class="step-copy tw:block tw:mt-s-2 tw:text-secondary tw:text-label tw:leading-loose">浏览故事与参考画面，找到想画的瞬间。</span></span></RouterLink></li>
      <li><RouterLink to="/prompt-builder"><img class="step-art" :src="createArt" width="512" height="512" alt="" loading="lazy" decoding="async" draggable="false" /><span class="step-number tw:grid tw:h-[40px] tw:rounded-md tw:text-accent">02</span><span><strong>在绘制台完成画面</strong><span class="step-copy tw:block tw:mt-s-2 tw:text-secondary tw:text-label tw:leading-loose">确认角色、画幅与氛围，把灵感画出来。</span></span></RouterLink></li>
      <li><RouterLink to="/gallery"><img class="step-art" :src="collectionArt" width="512" height="512" alt="" loading="lazy" decoding="async" draggable="false" /><span class="step-number tw:grid tw:h-[40px] tw:rounded-md tw:text-accent">03</span><span><strong>在「我的作品」回看</strong><span class="step-copy tw:block tw:mt-s-2 tw:text-secondary tw:text-label tw:leading-loose">查看已保存的作品，挑选喜欢的图片继续创作。</span></span></RouterLink></li>
    </ol>
    <details class="guide-help tw:mt-s-4 tw:text-secondary tw:text-label">
      <summary>开始前：生成条件、作品保存与参考样张</summary>
      <div class="guide-help-body tw:pb-s-4 tw:leading-loose" data-disclosure-content>
        <p><strong>生成条件：</strong>浏览场景后，可在绘制台确认所选引擎的连接状态。生成需要对应的绘图服务可用；未连接时先完成服务配置。</p>
        <p><strong>作品保存：</strong>本地作品档案与当前浏览器或桌面应用的数据有关。重要作品请及时下载备份，清理浏览器数据前先确认已保存。</p>
        <p><strong>参考样张：</strong>用于了解构图与风格；模型、参数和随机种子会影响结果，每次生成不保证与样张一致。</p>
        <a href="/docs/getting-started.html" target="_blank" rel="noopener">阅读完整使用指南（新窗口）</a>
      </div>
    </details>
  </section>
</template>

<script setup lang="ts">
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import inspirationOriginal from '@/assets/illustrations/atelier-inspiration-spot.webp'
import createOriginal from '@/assets/illustrations/atelier-create-spot.webp'
import collectionOriginal from '@/assets/illustrations/atelier-collection-spot.webp'
import { useThemeIllustration } from '@/composables/useThemeIllustration'
const inspirationArt = useThemeIllustration(inspirationOriginal, 'scene')
const createArt = useThemeIllustration(createOriginal, 'draw')
const collectionArt = useThemeIllustration(collectionOriginal, 'collection')
</script>

<style scoped>
@reference "../../assets/css/tailwind.css";
.creation-guide { margin-block: var(--s-6); }
.eyebrow { @apply tw:text-secondary tw:text-label-sm; }
h2 { margin: var(--s-2) 0 0; font: 600 var(--fs-title-sm)/var(--lh-label) var(--font-sans); text-wrap: balance; }
.guide-direct { @apply tw:inline-flex tw:items-center tw:gap-s-2 tw:min-h-[44px] tw:text-secondary tw:text-label; }
.guide-direct:hover { color: var(--accent); text-decoration: underline; text-underline-offset: .25em; }
/* One quiet reading surface keeps the three steps together, below the hero CTA. */
.guide-steps { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--s-1); list-style: none; padding: var(--s-2); border: 1px solid var(--border-soft); border-radius: var(--r-lg); background: var(--bg-surface); }
.guide-steps li { min-width: 0; }
.guide-steps a { @apply tw:grid tw:h-full tw:p-s-3; align-items: start; gap: var(--s-3); grid-template-columns:32px minmax(0,1fr) 64px; border-radius: var(--r-md); color: var(--text-primary); text-decoration: none; }
.step-art { grid-column:3; grid-row:1; align-self:center; display:block; width:64px; height:72px; object-fit:contain; }
.guide-steps .step-number { grid-column:1; grid-row:1; height:32px; background: var(--bg-base); color:var(--text-secondary); font-size:var(--fs-label-sm); font-variant-numeric:tabular-nums; }
.guide-steps a > span:last-child { grid-column:2; grid-row:1; min-width:0; }
.guide-steps a:hover strong { text-decoration:underline; text-underline-offset:.25em; }
.guide-steps a:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }
@media (hover: hover) and (pointer: fine) {
  .guide-steps a:hover { background: var(--bg-hover); }
}
.step-number { place-items:center; font:500 var(--fs-label-sm)/var(--lh-label) var(--font-sans); }
.guide-steps strong { @apply tw:block tw:text-body-sm; }
.guide-steps .step-copy { margin-top:var(--s-1); font-size:var(--fs-label-sm); overflow-wrap:anywhere; }
.guide-help { border-bottom: 1px solid var(--border-soft); }
.guide-help summary { padding-block: var(--s-3); @apply tw:min-h-[44px] tw:cursor-pointer; }
.guide-help summary:focus-visible, .guide-direct:focus-visible { outline:2px solid var(--accent); outline-offset:3px; border-radius:var(--r-sm); }
.guide-help-body { max-width: 80ch; }
.guide-help-body p { margin: 0 0 var(--s-3); }
.guide-help-body a { @apply tw:text-accent; text-decoration: underline; text-underline-offset: .2em; }
@media (max-width: 768px) {
  .guide-heading { align-items: start; @apply tw:flex-col tw:gap-s-2; }
  .guide-steps { grid-template-columns: minmax(0, 1fr); }
}
</style>
