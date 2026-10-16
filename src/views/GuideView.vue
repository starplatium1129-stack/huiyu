<template>
  <article class="page page-narrow guide-page" aria-labelledby="guide-title">
    <RouterLink class="nav-back" to="/">回到首页</RouterLink>
    <header class="page-header">
      <p class="page-kicker">使用指南</p>
      <h1 id="guide-title" class="page-title">开始你的第一张 CG</h1>
      <p class="page-subtitle">选场景、确认画面、生成并保存。按自己的节奏开始创作。</p>
    </header>

    <section class="guide-preparation" aria-labelledby="guide-preparation-title">
      <h2 id="guide-preparation-title">先确认绘图服务可用</h2>
      <p>浏览参考画册与场景不需要启动绘图模型。生成图片前，请在绘制台选择引擎，确认模型和连接状态。</p>
      <RouterLink to="/control#control-setup">配置模型与服务</RouterLink>
    </section>

    <ol class="guide-steps">
      <li>
        <h2>浏览灵感场景</h2>
        <p>在「灵感」中浏览故事、角色与画面设定，也可以按关键词搜索。想先了解构图与风格，可以翻看「参考画册」。</p>
        <div class="guide-links"><RouterLink to="/scene-explorer">浏览灵感</RouterLink><RouterLink to="/showcase">参考画册</RouterLink></div>
      </li>
      <li>
        <h2>选择喜欢的场景</h2>
        <p>打开场景查看设定，再进入绘制台。场景设定会随之带入；生成前确认角色、服装、画面描述和画幅，按需要调整。</p>
        <RouterLink to="/popular-scenes">按角色找场景</RouterLink>
      </li>
      <li>
        <h2>确认后生成图片</h2>
        <p>连接就绪后，使用绘制台的生成按钮提交任务。打开「任务」查看进度；遇到失败先阅读提示并检查服务，再重试。</p>
        <p>先用一张图确认效果，再考虑批量创作。模型、参数和随机种子都会影响最终画面。</p>
        <RouterLink class="btn btn-primary" to="/prompt-builder">打开绘制台</RouterLink>
      </li>
      <li>
        <h2>保存与回看作品</h2>
        <p>生成后将图片加入作品册，在「我的作品」回看、搜索或筛选。常用筛选组合可以命名保存，方便下次沿用。</p>
        <p>重要作品请下载备份，清理应用或浏览器数据前，先确认原图已保存。</p>
        <RouterLink to="/gallery">打开我的作品</RouterLink>
      </li>
    </ol>
  </article>
</template>

<style scoped>
.guide-page { --page-max: 860px; }
.page-header { margin-bottom: var(--s-6); }
.guide-preparation { padding: var(--s-5); border: 1px solid var(--border-soft); border-radius: var(--r-lg); background: var(--bg-surface); }
.guide-page h2 { margin: 0 0 var(--s-2); color: var(--text-primary); font-size: var(--fs-title-sm); }
.guide-page p { color: var(--text-secondary); line-height: var(--lh-loose); }
.guide-page p + p { margin-top: var(--s-2); }
.guide-page a:not(.nav-back) { display: inline-flex; align-items: center; gap: var(--s-2); min-height: 44px; color: var(--accent); text-underline-offset: 3px; }
.guide-page a:focus-visible { outline: none; box-shadow: var(--focus-shadow); border-radius: var(--r-sm); }
.guide-page .btn-primary { margin-top: var(--s-3); color: var(--text-inverse); }
.guide-steps { margin: var(--s-6) 0 0; padding-left: var(--s-6); }
.guide-steps li { padding: 0 0 var(--s-5) var(--s-3); }
.guide-steps li + li { padding-top: var(--s-5); border-top: 1px solid var(--border-soft); }
.guide-steps li::marker { color: var(--accent); font-weight: 700; }
.guide-links { display: flex; flex-wrap: wrap; gap: var(--s-4); }
</style>
