<template>
  <article class="page style-page" style="--page-max:1000px">
    <a class="nav-back" href="/" @click.prevent="$router.push('/')">← 回首页</a>
    <ArchivePageHero
      chapter="04"
      section="Visual grammar"
      shape="spark"
      label="由色彩和光线组成的抽象粒子标记"
      caption="PALETTE 04 / 08"
      compact
    >
      <div class="page-kicker">Art direction</div>
      <h1 class="title">画风</h1>
      <p class="subtitle">色调与光感决定画面的情绪温度。在此探索专属的艺术笔触与色彩剧本。</p>
    </ArchivePageHero>
    <CreativeLibraryNav />

    <div class="section-title" data-reveal>色彩氛围 · Color Moods</div>
    <p class="note mb-3" data-reveal>选择一抹倾心的色调，即可携同专属色彩脚本直接步入绘制工坊。</p>

    <div class="mood-grid mood-grid-lg stagger-container" data-reveal data-reveal-delay="1">
      <RouterLink
        v-for="m in MOODS"
        :key="m.id"
        :to="'/prompt-builder?mood=' + encodeURIComponent(m.id)"
        class="mood-card style-mood-card"
        :style="{ '--mood-color': m.colors[1] || m.colors[0] }"
      >
        <div class="mood-strip">
          <div
            v-for="(c, i) in m.colors"
            :key="c + i"
            class="mood-swatch"
            :style="{ '--swatch': c }"
          />
        </div>
        <div class="mood-body">
          <div class="mood-name"><ArchiveIcon :name="m.iconName" /> {{ m.name }} <span class="mood-en">{{ m.en }}</span></div>
          <div class="mood-desc">{{ m.desc }}</div>
          <div class="mood-prompt-hint">{{ m.prompt }}</div>
        </div>
        <span class="mood-go">用这个调子绘制 →</span>
      </RouterLink>
    </div>

    <div class="style-actions" data-reveal data-reveal-delay="2">
      <RouterLink to="/color-script" class="btn btn-ghost"><ArchiveIcon name="palette" /> 查看完整色彩剧本 (Color Script)</RouterLink>
      <RouterLink to="/prompt-builder" class="btn btn-primary"><ArchiveIcon name="spark" /> 直接开始绘制</RouterLink>
    </div>

    <section class="style-tips card-info" data-reveal data-reveal-delay="3">
      <h2 class="section-title m-0">使用提示</h2>
      <ul class="tip-list">
        <li>色板会写入工作台的「色彩情调」，并进入 Prompt。</li>
        <li>需要完整色相 / 光照映射时，打开色彩剧本页。</li>
        <li>同一情绪可与场景卡、镜头、光照叠加；冲突时以场景故事为准。</li>
      </ul>
    </section>
  </article>
</template>

<script setup lang="ts">
import CreativeLibraryNav from '@/components/library/CreativeLibraryNav.vue'
import { COLOR_MOODS } from '@/config/promptConstants'
import ArchivePageHero from '@/components/visual/ArchivePageHero.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { useScrollReveal } from '@/composables/useScrollReveal'

const MOODS = COLOR_MOODS
useScrollReveal()
</script>

<style scoped>
.style-page { padding-bottom: var(--s-8); }
.mood-en {
  margin-left: 6px;
  color: var(--text-muted);
  font: 500 var(--fs-mono-sm) var(--font-mono);
}
.mood-prompt-hint {
  margin-top: 6px;
  color: var(--text-muted);
  font: 400 var(--fs-mono-xs) / 1.5 var(--font-mono);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.style-mood-card {
  text-decoration: none;
  display: flex;
  flex-direction: column;
  position: relative;
}
.style-mood-card .mood-go {
  margin: 0 var(--s-3) var(--s-3);
  color: var(--accent);
  font: 650 var(--fs-label-xs) var(--font-sans);
  opacity: 0;
  transform: translateY(4px);
  transition: opacity var(--motion-hover), transform var(--motion-hover);
}
.style-mood-card:focus-visible .mood-go {
  opacity: 1;
  transform: none;
}
@media (hover: hover) and (pointer: fine) {
  .style-mood-card:hover .mood-go { opacity:1; transform:none; }
}
.style-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s-3);
  margin-top: var(--s-5);
}
.style-tips {
  margin-top: var(--s-6);
  padding: var(--s-5);
}
.tip-list {
  margin: var(--s-3) 0 0;
  padding-left: 1.2em;
  color: var(--text-secondary);
  font-size: var(--fs-body-sm);
  line-height: var(--lh-loose);
}
.tip-list li + li { margin-top: 4px; }
.m-0 { margin: 0; }
</style>
