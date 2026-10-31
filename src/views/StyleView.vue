<template>
  <article class="page style-page creative-library-page">
    <CreativeLibraryHeader title="画风" description="色彩情绪与氛围调子" />

    <header class="style-chapter" data-reveal>
      <h2>六种心情，六种色调</h2>
    </header>
    <p v-if="referenceError || referenceRetryStarted" class="library-reference-feedback"><span role="status">{{ loading ? '正在重新读取样张清单…' : referenceError || '样张清单已更新' }}</span><button type="button" class="btn btn-ghost btn-sm style-reference-retry" :aria-disabled="loading" @click="retryReferences"><ArchiveIcon name="refresh" />{{ loading ? '正在读取…' : '重新读取封面' }}</button></p>
    <div class="mood-grid style-mood-grid" data-route-arrive data-reveal data-reveal-delay="1">
      <article v-for="(m, moodIndex) in MOODS" :key="m.id" class="style-mood-card" :style="{ '--mood-color': m.colors[1] }">
        <RuntimeImage :src="referenceUrl(m.sceneId)" v-slot="{ image, loaded, failed }">
          <div class="style-sample-frame" :class="{ 'is-failed': failed }">
            <RouterLink class="style-sample" :to="'/showcase?scene=' + m.sceneId" :aria-label="'查看' + m.name + '氛围参考'">
              <img v-if="image.src && !failed" v-bind="image" :class="{ ready: loaded }" :alt="m.sampleTitle + ' · 氛围参考'" width="560" height="818" loading="lazy" decoding="async" />
              <span v-if="!loaded" class="style-sample-missing" role="status">
                <span class="style-palette-proof" aria-hidden="true"><span v-for="(color, index) in m.colors" :key="color + index" :style="{ '--proof-color': color, '--proof-index': index }"></span><ArchiveIcon :name="m.iconName" /></span>
                <span>{{ failed ? '参考图片加载失败' : image.src ? '正在载入画页…' : loading ? '正在翻开画册…' : '氛围参考暂未连接' }}</span><small v-if="failed || (!image.src && !loading)">仍可选用下方配色</small>
              </span>
            </RouterLink>
            <button v-if="failed" class="btn btn-ghost btn-sm style-sample-retry" type="button" :aria-label="'重新读取' + m.name + '氛围参考图'" @click="retryCover(m.sceneId, $event)"><ArchiveIcon name="refresh" />重新读取</button>
          </div>
        </RuntimeImage>
        <div class="style-card-body tw:p-s-4">
          <div class="style-card-heading tw:flex tw:items-center tw:justify-between tw:gap-s-2"><h3><ArchiveIcon :name="m.iconName" />{{ m.name }}</h3><span>{{ String(moodIndex + 1).padStart(2, '0') }} / {{ m.en }}</span></div>
          <p class="style-sample-caption">{{ m.caption }}</p>
          <div class="style-palette" aria-hidden="true"><span v-for="(color, index) in m.colors" :key="color + index" class="mood-swatch" :style="{ '--swatch': color, '--swatch-index': index }"></span></div>
          <div class="style-card-foot tw:mt-s-3 tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-s-2"><span>{{ m.desc }}</span><RouterLink :to="'/prompt-builder?mood=' + encodeURIComponent(m.id)" class="btn btn-ghost mood-go">以此调绘制<ArchiveIcon name="spark" /></RouterLink></div>
        </div>
        <CardEdgeLight />
      </article>
    </div>

    <section class="style-notes" data-reveal>
      <RouterLink to="/color-script" class="btn btn-ghost">色彩台本<ArchiveIcon name="palette" /></RouterLink>
    </section>
  </article>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import '@/assets/css/mood.css'
import RuntimeImage from '@/components/visual/RuntimeImage.vue'

import CreativeLibraryHeader from '@/components/library/CreativeLibraryHeader.vue'
import { COLOR_MOODS } from '@/config/promptConstants'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import CardEdgeLight from '@/components/visual/CardEdgeLight.vue'
import { useScrollReveal } from '@/composables/useScrollReveal'
import { useMoodReferences } from '@/composables/useMoodReferences'

// Existing All-rated showcase references, reviewed visually for atmosphere.
// Missing media keeps the same frame while the palette remains available.
const references: Record<string, { sceneId: string; sampleTitle: string; caption: string }> = {
  joy: { sceneId:'sc003', sampleTitle:'只告诉你的天台秘密', caption:'暖金夕照，照亮轻快的日常。' },
  love: { sceneId:'sc002', sampleTitle:'樱花树下的约定', caption:'樱色与柔光，留住欲言又止的心动。' },
  calm: { sceneId:'sc004', sampleTitle:'书架间的偶遇', caption:'窗边的书页，让喧嚣慢慢安静。' },
  sad: { sceneId:'sc007', sampleTitle:'雨声里的正式回答', caption:'蓝灰雨幕，衬出细腻的情绪。' },
  tension: { sceneId:'sc215', sampleTitle:'月光书页里的小小勇气', caption:'紫蓝月光，让明暗藏一点秘密。' },
  warmth: { sceneId:'sc006', sampleTitle:'平安夜的手作礼物', caption:'灯火与暖橙，把陪伴留在画里。' },
}
const MOODS = COLOR_MOODS.map(mood => ({ ...mood, ...references[mood.id]! }))
const { loading, error: referenceError, reload: reloadReferences, referenceUrl, retryReference } = useMoodReferences()
const referenceRetryStarted = ref(false)
function retryCover(id: string, event: MouseEvent) {
  const origin = event.currentTarget
  if (origin instanceof HTMLElement && document.activeElement === origin)
    origin.closest('.style-mood-card')?.querySelector<HTMLElement>('.style-sample')?.focus({ preventScroll: true })
  retryReference(id)
}
function retryReferences() {
  if (loading.value) return
  // Keep the recovery control mounted and focusable through the request and its result.
  referenceRetryStarted.value = true
  void reloadReferences().catch(() => {})
}
useScrollReveal()
</script>

<style scoped>@reference "../assets/css/tailwind.css";
.style-chapter { @apply tw:flex tw:justify-between tw:items-center tw:gap-s-5 tw:mb-s-4; }
.style-chapter h2 { @apply tw:m-0; font:500 var(--fs-title-sm)/var(--lh-label) var(--font-serif); }
.style-reference-retry[aria-disabled='true'] { color:var(--text-disabled); cursor:wait; pointer-events:auto; }
.style-reference-retry:focus-visible { outline:2px solid var(--focus-color); outline-offset:2px; }
.style-mood-grid { grid-template-columns:repeat(3,minmax(0,1fr)); @apply tw:gap-s-5; }
.style-mood-card { position:relative; isolation:isolate; @apply tw:min-w-0 tw:overflow-hidden; border:1px solid var(--border-soft); @apply tw:rounded-lg; background:var(--bg-surface); box-shadow:inset 0 1px 0 var(--glass-highlight),var(--shadow-sm); transition:transform var(--motion-surface) var(--ease-out); }
.style-mood-card::before { content:''; position:absolute; inset:0; z-index:-1; background:linear-gradient(160deg,transparent 45%,color-mix(in srgb,var(--mood-color) 9%,transparent)); pointer-events:none; }
.style-sample-frame { position:relative; }
.style-sample { position:relative; @apply tw:block; aspect-ratio:4 / 3; @apply tw:overflow-hidden; background:var(--bg-elevated); }
.style-sample img { @apply tw:w-full tw:h-full tw:object-cover; object-position:center 12%; @apply tw:block; opacity:0; transition:opacity var(--motion-surface) var(--ease-out),transform var(--motion-art-hover) var(--spring-soft); }
.style-sample img.ready { opacity:1; }
.style-sample::after { content:''; position:absolute; inset:0; pointer-events:none; background:radial-gradient(ellipse at 50% 30%,color-mix(in srgb,var(--on-art-primary) 18%,transparent),transparent 65%); opacity:0; transition:opacity var(--motion-route) var(--ease-out); }
.style-sample-missing { position:absolute; inset:0; @apply tw:h-full tw:p-s-4 tw:flex tw:flex-col tw:items-center tw:justify-center tw:gap-s-2 tw:text-secondary tw:text-center tw:text-body-sm; background:linear-gradient(150deg,color-mix(in srgb,var(--mood-color) 14%,var(--bg-surface)),var(--bg-elevated)); }
/* An unfinished artbook leaf keeps its actual palette, without posing as a CG. */
.style-palette-proof { position:relative; display:block; flex:none; width:120px; height:96px; margin-bottom:var(--s-2); }
.style-palette-proof::before { content:''; position:absolute; inset:8px 6px; border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--bg-surface); box-shadow:var(--shadow-sm); transform:rotate(-6deg); }
.style-palette-proof > span { position:absolute; top:8px; left:calc(45px + (var(--proof-index) - 2) * 13px); width:30px; height:60px; border:1px solid var(--border-soft); border-radius:var(--r-sm); background:var(--proof-color); box-shadow:var(--shadow-sm); transform-origin:50% 100%; transform:rotate(calc((var(--proof-index) - 2) * 12deg)); }
.style-palette-proof .archive-icon { position:absolute; left:44px; bottom:0; box-sizing:content-box; width:18px; height:18px; padding:var(--s-2); border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--bg-surface); color:var(--text-secondary); }
.style-sample-missing small { font-size:inherit; }
.style-sample-frame.is-failed .style-sample-missing { padding:var(--s-2) var(--s-3) calc(var(--control-height) + var(--s-4)); gap:var(--s-1); }
.style-sample-frame.is-failed .style-palette-proof { height:64px; margin-bottom:0; }
.style-sample-frame.is-failed .style-palette-proof::before { inset:6px 16px; }
.style-sample-frame.is-failed .style-palette-proof > span { top:4px; left:calc(48px + (var(--proof-index) - 2) * 10px); width:24px; height:40px; }
.style-sample-frame.is-failed .style-palette-proof .archive-icon { left:48px; width:14px; height:14px; padding:var(--s-1); }
.style-sample-retry { position:absolute; z-index:var(--z-raised); inset:auto var(--s-3) var(--s-3); justify-content:center; min-height:var(--control-height); background:var(--bg-surface); }
.style-sample-retry:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
.style-card-heading h3 { @apply tw:flex tw:items-center tw:gap-s-2 tw:m-0 tw:text-primary; font:500 var(--fs-title-sm)/var(--lh-label) var(--font-serif); }
.style-card-heading .archive-icon { box-sizing:content-box; padding:var(--s-2); border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--bg-surface); @apply tw:text-accent; width:18px; height:18px; }
.style-card-heading > span { @apply tw:text-muted; font:400 var(--fs-mono-xs)/var(--lh-label) var(--font-mono); text-align:right; }
.style-sample-caption { margin:var(--s-2) 0 var(--s-4); @apply tw:text-secondary tw:text-body-sm tw:leading-body; }
/* Inspira UI Fey Cards' staggered layers, adapted to a finite palette fan.
   Source: unovue/inspira-ui@04c57ab62b9713872ebbf68988dff1836ed3d764; MIT: assets/licenses/inspira-ui.txt. */
.style-palette { display:flex; gap:var(--s-2); height:40px; padding-top:var(--s-2); }
.style-palette .mood-swatch { border:1px solid var(--border-soft); border-radius:var(--r-sm); box-shadow:var(--shadow-sm); transform-origin:50% 100%; transition:transform var(--motion-route-cut) var(--spring-soft); transition-delay:calc(var(--swatch-index) * var(--motion-control) / 10); }
.mood-go .archive-icon { transition:transform var(--motion-route) var(--spring-soft); }
.style-mood-card:has(:focus-visible) :is(.style-sample img,.mood-swatch,.mood-go .archive-icon) { transition:none; transform:none; }
.style-mood-card:has(:focus-visible) { transition:none; transform:none; }
.style-card-foot > span { @apply tw:text-muted tw:text-body-sm; }
.mood-go:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
.style-sample:focus-visible { outline:none; }
/* The card clips artwork; paint the focus ring inside the image viewport. */
.style-sample:focus-visible::after { opacity:1; background:transparent; box-shadow:inset 0 0 0 2px var(--bg-base),inset 0 0 0 4px var(--focus-color); transition:none; }
.style-notes { @apply tw:flex tw:items-center tw:gap-s-4 tw:mt-s-7 tw:pt-s-5; border-top:1px solid var(--border-soft); }
.style-notes .btn { @apply tw:shrink-0; }
@media (hover:hover) and (pointer:fine) {
  .style-mood-card:hover:not(:focus-within) { transform:translateY(-2px); }
  .style-mood-card:hover:not(:focus-within) .style-sample img { transform:scale(1.06) translateY(-4px); }
  .style-mood-card:hover .style-sample::after { opacity:1; }
  .style-mood-card:hover:not(:focus-within) .mood-swatch { transform:translateY(-6px) rotate(-4deg); }
  .style-mood-card:hover:not(:focus-within) .mood-swatch:nth-child(even) { transform:translateY(-3px) rotate(4deg); }
  .mood-go:hover:not(:focus-visible) .archive-icon { transform:translateX(4px) rotate(12deg); }
}
@media (max-width:900px) { .style-mood-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } .style-chapter { align-items:start; @apply tw:flex-col tw:gap-s-3; } .style-notes { @apply tw:flex-wrap; } }
@media (max-width:540px) { .style-mood-grid { grid-template-columns:minmax(0,1fr); } .style-chapter h2 { @apply tw:text-title-sm; } }
:root:is([data-motion='reduce'],[data-motion='reduced']) .style-page :is(.style-mood-card,.style-sample img,.mood-swatch,.mood-go .archive-icon) { transition:none; transform:none; }
:root:is([data-motion='reduce'],[data-motion='reduced']) .style-sample::after { transition:none; }
@media (prefers-reduced-motion:reduce) {
  :root:not([data-motion='full']) .style-page :is(.style-mood-card,.style-sample img,.mood-swatch,.mood-go .archive-icon) { transition:none; transform:none; }
  :root:not([data-motion='full']) .style-sample::after { transition:none; }
}
@media (forced-colors:active) { .style-mood-card::before,.style-sample::after { display:none; } .style-sample:focus-visible { outline:2px solid Highlight; outline-offset:-4px; } .style-sample-retry:focus-visible { outline:2px solid Highlight; outline-offset:2px; } }
</style>
