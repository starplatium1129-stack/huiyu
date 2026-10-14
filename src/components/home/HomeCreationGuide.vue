<template>
  <section class="creation-guide container" aria-labelledby="creation-guide-title">
    <header class="guide-heading tw:flex tw:items-center tw:justify-between tw:gap-s-4 tw:mb-s-4">
      <h2 id="creation-guide-title">从灵感到作品</h2>
      <a href="/docs/getting-started.html" class="guide-direct" target="_blank" rel="noopener" aria-label="使用指南，在新窗口打开">使用指南 <ArchiveIcon name="book" /></a>
    </header>
    <ol class="guide-steps tw:grid tw:gap-s-4 tw:p-0 tw:m-0">
      <li><RouterLink to="/scene-explorer"><img class="step-art" :src="inspirationArt" width="512" height="512" alt="" loading="lazy" decoding="async" draggable="false" /><span class="step-number tw:grid tw:h-[40px] tw:rounded-md tw:text-accent">01</span><strong>选场景</strong></RouterLink></li>
      <li><RouterLink to="/prompt-builder"><img class="step-art" :src="createArt" width="512" height="512" alt="" loading="lazy" decoding="async" draggable="false" /><span class="step-number tw:grid tw:h-[40px] tw:rounded-md tw:text-accent">02</span><strong>绘制</strong></RouterLink></li>
      <li><RouterLink to="/gallery"><img class="step-art" :src="collectionArt" width="512" height="512" alt="" loading="lazy" decoding="async" draggable="false" /><span class="step-number tw:grid tw:h-[40px] tw:rounded-md tw:text-accent">03</span><strong>我的作品</strong></RouterLink></li>
    </ol>
    <details class="guide-help tw:mt-s-4 tw:text-secondary tw:text-label">
      <summary>生成与保存</summary>
      <div class="guide-help-body tw:pb-s-4 tw:leading-loose" data-disclosure-content>
        <p>生成需要连接绘图服务。清理应用或浏览器数据前，请下载重要作品。</p>
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
h2 { margin: var(--s-2) 0 0; font: 500 var(--fs-title-sm)/var(--lh-label) var(--font-serif); }
.guide-direct { @apply tw:inline-flex tw:items-center tw:gap-s-2 tw:min-h-[44px] tw:text-accent tw:text-label; }
.guide-steps { grid-template-columns: repeat(3, minmax(0, 1fr)); list-style: none; }
.guide-steps a { @apply tw:grid tw:gap-s-3 tw:h-full tw:p-s-4; grid-template-columns:40px minmax(0,1fr); grid-template-rows:auto 1fr; border: 1px solid transparent; @apply tw:rounded-xl; background: transparent; @apply tw:text-primary; text-decoration: none; transition: transform var(--motion-hover) var(--ease-out); }
.step-art { grid-column:1/-1; display:block; width:100%; height:clamp(112px,12vw,164px); object-fit:contain; }
.guide-steps a:hover strong { text-decoration:underline; text-underline-offset:.25em; }
.guide-steps a:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
@media (hover: hover) and (pointer: fine) {
  .guide-steps a:hover { transform: translateY(-2px); }
}
@media (prefers-reduced-motion: reduce) {
  :root:not([data-motion='full']) .guide-steps a { transition: none; }
  :root:not([data-motion='full']) .guide-steps a:hover { transform: none; }
}
:root:is([data-motion="reduce"], [data-motion="reduced"]) .creation-guide .guide-steps a { transition:none; transform:none; }
.step-number { place-items:center; flex:0 0 40px; font:500 var(--fs-body)/var(--lh-label) var(--font-sans); }
.guide-steps strong { @apply tw:block tw:text-body-sm; }
.guide-help { border-bottom: 1px solid var(--border-soft); }
.guide-help summary { padding-block: var(--s-3); @apply tw:min-h-[44px] tw:cursor-pointer; }
.guide-help-body { max-width: 80ch; }
.guide-help-body p { margin: 0 0 var(--s-3); }
@media (max-width: 768px) {
  .guide-heading { align-items: start; @apply tw:flex-col tw:gap-s-2; }
  .guide-steps { grid-template-columns: minmax(0, 1fr); @apply tw:gap-s-2; }
}
</style>
