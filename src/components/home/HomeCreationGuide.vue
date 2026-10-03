<template>
  <section class="creation-guide container" aria-labelledby="creation-guide-title">
    <div class="guide-tools"><h2 id="creation-guide-title">画室里的小抽屉</h2><nav aria-label="创作资料"><RouterLink to="/character"><ArchiveIcon name="character" />角色档案</RouterLink><RouterLink to="/style"><ArchiveIcon name="palette" />画风</RouterLink><RouterLink to="/lora"><ArchiveIcon name="model" />模型</RouterLink></nav><a href="/docs/getting-started.html" target="_blank" rel="noopener" class="guide-direct">使用指南 <span aria-hidden="true">↗</span></a></div>
    <details class="guide-help"><summary>第一次来？从灵感到作品 <ArchiveIcon name="chevron-down" /></summary><div class="guide-help-body"><ol class="guide-steps"><li><RouterLink to="/scene-explorer"><span class="step-number">01</span><span><strong>挑一个场景</strong><span class="step-copy">找到想画的瞬间。</span></span></RouterLink></li><li><RouterLink to="/prompt-builder"><span class="step-number">02</span><span><strong>在绘制台完成画面</strong><span class="step-copy">确认角色、画幅与氛围。</span></span></RouterLink></li><li><RouterLink to="/gallery"><span class="step-number">03</span><span><strong>在「我的作品」回看</strong><span class="step-copy">保存，也可以继续创作。</span></span></RouterLink></li></ol><div class="guide-notes"><p><strong>生成条件：</strong>绘制台会显示引擎连接状态；生成前需要对应绘图服务可用。</p><p><strong>作品保存：</strong>作品保存在当前浏览器或桌面应用的本地档案。重要作品请及时下载备份。</p><p><strong>参考样张：</strong>用于了解构图与风格，模型、参数与随机种子会影响结果。</p></div></div></details>
  </section>
</template>
<script setup lang="ts">
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
</script>
<style scoped>
.creation-guide { margin-block: var(--s-6) 0; }
.guide-tools { display: flex; align-items: center; flex-wrap: wrap; gap: var(--s-4) var(--s-6); padding-block: var(--s-4); border-top: 1px solid var(--album-edge); }
.guide-tools h2 { margin: 0; color: var(--text-primary); font: 600 var(--fs-body-sm)/var(--lh-label) var(--font-sans); }
.guide-tools nav { display: flex; align-items: center; flex-wrap: wrap; gap: var(--s-5); }
.guide-tools a { display: inline-flex; align-items: center; gap: var(--s-2); min-height: 44px; color: var(--text-secondary); font-size: var(--fs-label-sm); }
.guide-tools a:hover { color: var(--accent); }
.guide-tools .archive-icon { width: 18px; height: 18px; }
.guide-direct { margin-left: auto; }
.guide-help { border-top: 1px solid var(--album-edge); border-bottom: 1px solid var(--album-edge); color: var(--text-secondary); font-size: var(--fs-label-sm); }
.guide-help summary { display: flex; align-items: center; justify-content: space-between; gap: var(--s-3); min-height: 48px; padding-block: var(--s-3); list-style: none; cursor: pointer; }
.guide-help summary::-webkit-details-marker { display: none; }
.guide-help[open] summary .archive-icon { transform: rotate(180deg); }
.guide-help-body { padding-bottom: var(--s-4); }
.guide-steps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--s-4); padding: 0; margin: 0 0 var(--s-4); list-style: none; }
.guide-steps a { display: flex; align-items: center; gap: var(--s-3); height: 100%; padding: var(--s-4); border-radius: var(--r-md); background: var(--album-surface); color: var(--text-primary); }
.step-number { display: grid; place-items: center; flex: 0 0 32px; color: var(--accent); font: 500 var(--fs-body)/var(--lh-label) var(--font-mono); }
.guide-steps strong { display: block; font-size: var(--fs-label-sm); }
.step-copy { display: block; margin-top: var(--s-1); color: var(--text-muted); font-size: var(--fs-label-xs); }
.guide-notes { max-width: 86ch; color: var(--text-secondary); line-height: var(--lh-body); }
.guide-notes p { margin: var(--s-2) 0; }
.creation-guide :is(a, summary):focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: var(--r-sm); }
@media (max-width: 800px) { .guide-tools { gap: var(--s-2) var(--s-4); } .guide-tools nav { gap: var(--s-4); } .guide-steps { grid-template-columns: minmax(0, 1fr); gap: var(--s-2); } }
</style>
