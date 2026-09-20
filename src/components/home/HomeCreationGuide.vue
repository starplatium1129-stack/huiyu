<template>
  <section class="creation-guide container" aria-labelledby="creation-guide-title">
    <header class="guide-heading">
      <div><span class="eyebrow">从灵感到作品</span><h2 id="creation-guide-title">第一张 CG，从这里开始</h2></div>
      <RouterLink to="/prompt-builder" class="guide-direct">已有想法？直接绘制 <ArchiveIcon name="spark" /></RouterLink>
    </header>
    <ol class="guide-steps">
      <li><RouterLink to="/scene-explorer"><span class="step-number">01</span><span><strong>挑一个场景</strong><span class="step-copy">浏览故事与参考画面，找到想画的瞬间。</span></span></RouterLink></li>
      <li><RouterLink to="/prompt-builder"><span class="step-number">02</span><span><strong>在绘制台完成画面</strong><span class="step-copy">从场景进入后，确认角色、画幅与参数，再生成。</span></span></RouterLink></li>
      <li><RouterLink to="/gallery"><span class="step-number">03</span><span><strong>在「我的作品」回看</strong><span class="step-copy">查看已保存的作品，挑选喜欢的图片继续创作。</span></span></RouterLink></li>
    </ol>
    <details class="guide-help">
      <summary>开始前：生成条件、作品保存与参考样张</summary>
      <div class="guide-help-body">
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
</script>

<style scoped>
.creation-guide { margin-block: var(--s-7); }
.guide-heading { display: flex; align-items: center; justify-content: space-between; gap: var(--s-4); margin-bottom: var(--s-4); }
.eyebrow { color: var(--text-secondary); font-size: var(--fs-label-sm); }
h2 { margin: var(--s-2) 0 0; font: 500 var(--fs-title)/var(--lh-label) var(--font-serif); }
.guide-direct { display: inline-flex; align-items: center; gap: var(--s-2); min-height: 44px; color: var(--accent); font-size: var(--fs-label); }
.guide-steps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--s-4); padding: 0; margin: 0; list-style: none; }
.guide-steps a { display: flex; gap: var(--s-3); height: 100%; padding: var(--s-4); border: 1px solid var(--border-soft); border-radius: var(--r-xl); background: var(--bg-surface); color: var(--text-primary); text-decoration: none; }
.guide-steps a:hover { border-color:var(--accent); background:var(--bg-hover); }
.guide-steps a:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }
.step-number { display:grid; place-items:center; flex:0 0 40px; height:40px; border-radius:var(--r-md); background:var(--accent-soft); color:var(--accent); font:500 var(--fs-body)/var(--lh-label) var(--font-sans); }
.guide-steps strong { display: block; font-size: var(--fs-body-sm); }
.step-copy { display: block; margin-top: var(--s-2); color: var(--text-secondary); font-size: var(--fs-label); line-height: var(--lh-loose); }
.guide-help { margin-top: var(--s-4); border-bottom: 1px solid var(--border-soft); color: var(--text-secondary); font-size: var(--fs-label); }
.guide-help summary { padding-block: var(--s-3); min-height: 44px; cursor: pointer; }
.guide-help-body { max-width: 80ch; padding-bottom: var(--s-4); line-height: var(--lh-loose); }
.guide-help-body p { margin: 0 0 var(--s-3); }
.guide-help-body a { color: var(--accent); text-decoration: underline; text-underline-offset: .2em; }
@media (max-width: 768px) {
  .guide-heading { align-items: start; flex-direction: column; gap: var(--s-2); }
  .guide-steps { grid-template-columns: minmax(0, 1fr); gap: var(--s-2); }
}
</style>
