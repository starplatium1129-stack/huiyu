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
        <RouterLink class="style-sample" :to="'/showcase?scene=' + m.sceneId" :aria-label="'查看' + m.name + '氛围参考'">
          <img v-if="available.has(m.sceneId) && !failedSamples.has(m.id)" :src="'/scene-showcase/thumbs/' + m.sceneId + '.jpg'" :alt="m.sampleTitle + ' · 氛围参考'" width="560" height="818" loading="lazy" decoding="async" @error="failedSamples.add(m.id)" />
          <span v-else class="style-sample-missing"><ArchiveIcon name="image" /><span>{{ loading ? '正在翻开画册…' : '氛围参考暂未连接' }}</span><small>仍可选用下方配色</small></span>
        </RouterLink>
        <div class="style-card-body">
          <div class="style-card-heading"><h3><ArchiveIcon :name="m.iconName" />{{ m.name }}</h3><span>{{ m.en }}</span></div>
          <p class="style-sample-caption">{{ m.caption }}</p>
          <div class="mood-strip" aria-hidden="true"><span v-for="(color, index) in m.colors" :key="color + index" class="mood-swatch" :style="{ '--swatch': color }"></span></div>
          <div class="style-card-foot"><span>{{ m.desc }}</span><RouterLink :to="'/prompt-builder?mood=' + encodeURIComponent(m.id)" class="mood-go">用这个调子绘制<ArchiveIcon name="spark" /></RouterLink></div>
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

<style scoped>
.style-page { padding-top:var(--s-5); padding-bottom:var(--s-8); }
.style-page :deep(.archive-copy) { padding-block:var(--s-4); }
.style-chapter { display:flex; justify-content:space-between; align-items:end; gap:var(--s-5); margin:var(--s-6) 0 var(--s-5); }
.style-eyebrow { font-size:var(--fs-body-sm); color:var(--accent); letter-spacing:.08em; }
.style-chapter h2 { margin:var(--s-2) 0 0; font:500 var(--fs-title)/var(--lh-label) var(--font-serif); }
.style-chapter p { max-width:340px; color:var(--text-secondary); font-size:var(--fs-body-sm); line-height:var(--lh-body); }
.style-mood-grid { grid-template-columns:repeat(3,minmax(0,1fr)); gap:var(--s-5); }
.style-mood-card { min-width:0; overflow:hidden; border:1px solid var(--border-soft); border-radius:var(--r-xl); background:var(--bg-surface); }
.style-sample { display:block; aspect-ratio:4 / 3; overflow:hidden; background:var(--bg-elevated); }
.style-sample img { width:100%; height:100%; object-fit:cover; object-position:center 12%; display:block; transition:transform var(--motion-surface) var(--ease-out); }
.style-sample-missing { height:100%; padding:var(--s-4); display:flex; flex-direction:column; align-items:center; justify-content:center; gap:var(--s-2); color:var(--text-secondary); text-align:center; font-size:var(--fs-body-sm); }
.style-sample-missing .archive-icon { width:32px; height:32px; }
.style-sample-missing small { font-size:inherit; }
.style-card-body { padding:var(--s-4); }
.style-card-heading { display:flex; align-items:center; justify-content:space-between; gap:var(--s-2); }
.style-card-heading h3 { display:flex; align-items:center; gap:var(--s-2); margin:0; color:var(--text-primary); font:500 var(--fs-title-sm)/var(--lh-label) var(--font-serif); }
.style-card-heading .archive-icon { color:var(--accent); }
.style-card-heading > span { color:var(--text-muted); font-size:var(--fs-body-sm); }
.style-sample-caption { margin:var(--s-2) 0 var(--s-4); color:var(--text-secondary); font-size:var(--fs-body-sm); line-height:var(--lh-body); }
.style-card-body .mood-strip { height:12px; border-radius:var(--r-xs); overflow:hidden; }
.style-card-foot { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:var(--s-2); margin-top:var(--s-3); }
.style-card-foot > span { color:var(--text-muted); font-size:var(--fs-body-sm); }
.mood-go { display:inline-flex; align-items:center; gap:var(--s-1); min-height:44px; color:var(--accent); font-size:var(--fs-body-sm); font-weight:600; }
.style-sample:focus-visible, .mood-go:focus-visible { outline:2px solid var(--accent); outline-offset:-3px; border-radius:var(--r-sm); }
.style-notes { display:flex; align-items:center; gap:var(--s-4); margin-top:var(--s-7); padding-top:var(--s-5); border-top:1px solid var(--border-soft); }
.style-notes > .archive-icon { width:28px; height:28px; color:var(--accent); flex-shrink:0; }
.style-notes h2 { margin:0 0 var(--s-2); font-size:var(--fs-body); }
.style-notes p { color:var(--text-secondary); font-size:var(--fs-body-sm); line-height:var(--lh-body); }
.style-notes .btn { flex-shrink:0; }
@media (hover:hover) { .style-sample:hover img { transform:scale(1.035); } .mood-go:hover { text-decoration:underline; text-underline-offset:4px; } }
@media (max-width:900px) { .style-mood-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } .style-chapter { align-items:start; flex-direction:column; gap:var(--s-3); } .style-chapter p { max-width:none; } .style-notes { flex-wrap:wrap; } }
@media (max-width:540px) { .style-mood-grid { grid-template-columns:minmax(0,1fr); } .style-chapter h2 { font-size:var(--fs-title-sm); } }
@media (prefers-reduced-motion:reduce) { .style-sample img { transition:none; } }
</style>
