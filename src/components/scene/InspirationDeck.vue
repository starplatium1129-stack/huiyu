<template>
  <section v-if="rails.length" class="inspiration-deck" aria-label="翻阅灵感推荐">
    <div class="inspiration-deck-intro">
      <span class="inspiration-deck-kicker"><ArchiveIcon name="spark" /> 灵感手帖</span>
      <p :id="hintId" class="sr-only">左右方向键切换主推，也可拖动画面旁的文字区域。按 Tab 预览或探索任一场景。</p>
      <div class="inspiration-deck-controls" data-fluid-glass>
        <button type="button" aria-label="上一张灵感" :disabled="rails.length < 2" @click="step(-1)"><ArchiveIcon name="chevron-down" class="previous-icon" /></button>
        <span class="inspiration-deck-count" role="status" aria-live="polite" aria-atomic="true">
          <span aria-hidden="true">{{ String(index + 1).padStart(2, '0') }} / {{ String(rails.length).padStart(2, '0') }}</span>
          <span class="sr-only">第 {{ index + 1 }} 张，共 {{ rails.length }} 张：{{ entries[index]?.scene?.title || rails[index]?.title }}</span>
        </span>
        <button type="button" aria-label="下一张灵感" :disabled="rails.length < 2" @click="step(1)"><ArchiveIcon name="chevron-down" class="next-icon" /></button>
      </div>
    </div>
    <div ref="host" class="inspiration-deck-stage" tabindex="0" role="group" aria-label="灵感卡片，左右方向键翻页"
      :aria-describedby="hintId" :class="{ dragging, still: !canAnimate || resetting }" :style="{ '--inspiration-side-count': Math.max(1, cards.length - 1) }"
      @pointerdown="pointerDown" @pointermove="pointerMove" @pointerup="pointerUp"
      @pointercancel="cancel" @lostpointercapture="cancel" @keydown="keydown" @click.capture="clickCapture"
      @pointerleave="!dragging && cancel()" @dragstart.prevent>
      <article v-for="(item, depth) in cards" :key="item.key" class="inspiration-deck-card"
        :class="{ front: depth === 0, 'inspiration-feature': depth === 0, 'only-card': cards.length === 1 }" :data-character="item.rail.character"
        :style="depth === 0 ? { '--deck-x': `${turning ? -turning * 16 : canAnimate ? dragX : 0}px`, '--deck-opacity': turning ? 0 : 1 } : undefined">
        <div v-if="depth === 0" class="inspiration-feature-copy">
          <span class="inspiration-feature-label">{{ item.scene ? sceneCharacter(item.scene) : '灵感手帖' }}</span>
          <h2>{{ item.scene?.title || item.rail.title }}</h2>
          <p>{{ item.rail.subtitle }}</p>
          <div class="inspiration-feature-actions">
            <RouterLink v-if="item.scene" class="btn btn-primary inspiration-feature-draw" :to="'/prompt-builder?scene=' + encodeURIComponent(item.scene.id)"><ArchiveIcon name="spark" />用这一幕绘制</RouterLink>
            <button class="inspiration-deck-open" type="button" :disabled="Boolean(turning)" :aria-label="'探索：' + item.rail.title" @click="emit('select', item.rail)">探索场景 <ArchiveIcon name="chevron-down" class="next-icon" /></button>
          </div>
        </div>
        <button class="inspiration-deck-image" :class="{ 'inspiration-feature-image': depth === 0 }" type="button" :disabled="!item.scene"
          :aria-label="item.scene ? '查看完整场景：' + item.scene.title : '此灵感暂未提供场景图片'" @click="item.scene && emit('open', item.scene)">
          <InspirationArtwork :scene="item.scene" :icon="railIconName(item.rail.icon)" :full="depth === 0" />
        </button>
        <div v-if="depth !== 0" class="inspiration-deck-copy">
          <h2>{{ item.scene?.title || item.rail.title }}</h2>
          <span class="inspiration-deck-subtitle">{{ item.rail.subtitle }}</span>
          <button class="inspiration-deck-open" type="button" :disabled="Boolean(turning)" :aria-label="'探索：' + item.rail.title" @click="emit('select', item.rail)">探索场景 <ArchiveIcon name="chevron-down" class="next-icon" /></button>
        </div>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import { RouterLink } from 'vue-router'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import InspirationArtwork from './InspirationArtwork.vue'
import { railIconName, type ExplorerScene } from '@/composables/scene/sceneExplorerPresentation'
import { useInspirationDeck } from '@/composables/scene/useInspirationDeck'
import { analyzeQuery, matchesSearch, searchScore } from '@/utils/sceneUX'

interface MoodRail { character: string; icon?: string; title: string; subtitle: string; query: string }
const props = withDefaults(defineProps<{ rails: MoodRail[]; scenes?: ExplorerScene[] }>(), { scenes: () => [] })
const emit = defineEmits<{ select: [rail: MoodRail]; open: [scene: ExplorerScene] }>()
const hintId = useId()
const host = ref<HTMLElement | null>(null)
// Visible recommendations share the loaded catalog, with one distinct All-rated
// scene per rail. Missing matches keep their usable exploration link.
const entries = computed(() => {
  const used = new Set<string>()
  return props.rails.map((rail, i) => {
    const analysis = analyzeQuery(rail.query, null)
    let scene: ExplorerScene | undefined, bestScore = -Infinity
    for (const candidate of props.scenes) {
      if (used.has(candidate.id) || candidate.rating !== 'All' || candidate.mature === true
        || (rail.character !== 'shared' && candidate.char !== rail.character)
        || !matchesSearch(candidate, rail.query, null, undefined, analysis)) continue
      const score = searchScore(candidate, rail.query, null, undefined, analysis)
      if (score > bestScore) { scene = candidate; bestScore = score }
    }
    if (scene) used.add(scene.id)
    return { rail, scene, key: `${i}:${rail.title}:${rail.query}` }
  })
})
const keys = computed(() => entries.value.map(item => item.key))
const { index, dragX, dragging, turning, resetting, canAnimate, step, pointerDown, pointerMove,
  pointerUp, cancel, clickCapture, keydown } = useInspirationDeck(host, () => keys.value)
function sceneCharacter(scene: ExplorerScene) { return scene.char === 'natsume' ? '四季夏目' : scene.char === 'nene' ? '绫地宁宁' : '双人场景' }
const cards = computed(() => Array.from({ length: Math.min(3, entries.value.length) }, (_, depth) =>
  entries.value[(index.value + depth) % entries.value.length]))
</script>

<style scoped>
.inspiration-deck { grid-area:moods; min-width:0; width:100%; }
.inspiration-deck-intro { display:flex; align-items:center; justify-content:space-between; gap:var(--s-2); margin-bottom:var(--s-3); }
.inspiration-deck-kicker { display:flex; align-items:center; gap:var(--s-1); color:var(--text-secondary); font-size:var(--fs-label-sm); font-weight:600; }
.inspiration-deck-kicker .archive-icon { width:16px; height:16px; }
.inspiration-deck-controls { display:flex; align-items:center; gap:var(--s-1); }
.inspiration-deck-controls button { display:grid; place-items:center; width:var(--control-height-sm); height:var(--control-height-sm); border:0; border-radius:var(--r-sm); color:var(--text-secondary); background:transparent; cursor:pointer; }
.inspiration-deck-controls button:hover { color:var(--accent); background:var(--accent-soft); }
.inspiration-deck-controls button:active { transform:scale(.94); }
.inspiration-deck button:disabled { color:var(--text-disabled); cursor:default; }
.inspiration-deck-count { color:var(--text-muted); font:500 var(--fs-label-xs)/1 var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
.previous-icon { transform:rotate(90deg); }
.next-icon { transform:rotate(-90deg); }
.inspiration-deck-stage { --inspiration-height:clamp(280px,28dvh,320px); display:grid; grid-template-columns:minmax(0,1.8fr) repeat(var(--inspiration-side-count),minmax(0,1fr)); align-items:stretch; gap:var(--s-4); position:relative; min-width:0; touch-action:pan-y; border-radius:var(--r-lg); }
.inspiration-deck-stage.dragging { cursor:grabbing; user-select:none; }
.inspiration-deck-card { --card-focus-lift:0px; --card-focus-scale:1; display:grid; grid-template-rows:minmax(0,1fr) auto; height:var(--inspiration-height); min-width:0; padding:var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--bg-surface); transform:translateY(var(--card-focus-lift)); transition:transform var(--motion-surface) var(--ease-out); }
.inspiration-deck-card.only-card { grid-column:1/-1; }
.inspiration-deck-card.front { transform:translate3d(var(--deck-x),var(--card-focus-lift),0); opacity:var(--deck-opacity); transition:transform 240ms var(--ease-out),opacity 240ms var(--ease-out); }
.inspiration-deck-stage:not(.dragging):not(.still) .inspiration-deck-card:has(:focus-visible) { --card-focus-lift:-6px; --card-focus-scale:1.06; border-color:var(--accent); box-shadow:var(--shadow-md); }
.inspiration-deck-card:has(:focus-visible) :deep(.inspiration-artwork.ready::after) { opacity:1; }
.inspiration-deck-card :deep(.inspiration-artwork.ready img) { transform:scale(var(--card-focus-scale)); }
@media (hover:hover) and (pointer:fine) {
  .inspiration-deck-stage:not(.dragging):not(.still) .inspiration-deck-card:hover { --card-focus-lift:-6px; --card-focus-scale:1.06; border-color:var(--accent); box-shadow:var(--shadow-md); }
  .inspiration-deck-card:hover :deep(.inspiration-artwork.ready::after) { opacity:1; }
}
.inspiration-deck-stage.dragging .front, .inspiration-deck-stage.still .front { transition:none; }
.inspiration-deck-stage.still .inspiration-deck-card { transition:none; --card-focus-lift:0px; --card-focus-scale:1; }
.inspiration-deck-image { --inspiration-art-height:100%; display:flex; align-items:center; justify-content:center; width:100%; min-width:0; min-height:0; padding:0; border:0; background:transparent; cursor:zoom-in; }
.inspiration-deck-image :deep(.inspiration-artwork) { width:100%; height:100%; border:0; background:transparent; }
.inspiration-deck-copy { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; justify-items:start; gap:var(--s-1) var(--s-2); padding-top:var(--s-2); min-width:0; }
.inspiration-deck-copy h2 { margin:0; color:var(--text-primary); font:600 var(--fs-label-sm)/var(--lh-body) var(--font-display); letter-spacing:-.02em; }
.inspiration-deck-subtitle { grid-column:1/-1; color:var(--text-muted); font-size:var(--fs-label-xs); }
.inspiration-deck-copy .inspiration-deck-open { grid-column:2; grid-row:1; }
.inspiration-deck-open { display:inline-flex; align-items:center; gap:var(--s-1); min-height:var(--control-height-sm); padding:0; border:0; background:transparent; color:var(--accent); font:500 var(--fs-label-sm)/var(--lh-body) var(--font-sans); cursor:pointer; }
.inspiration-deck-open:hover { text-decoration:underline; text-underline-offset:3px; }
.inspiration-deck-stage:focus-visible, .inspiration-deck :is(button,a):focus-visible { outline:2px solid var(--accent); outline-offset:3px; }
.inspiration-feature { grid-template-columns:minmax(0,1fr) minmax(0,1fr); grid-template-rows:minmax(0,1fr); align-items:stretch; gap:var(--s-3); padding:var(--s-4); }
.inspiration-feature-copy { display:flex; flex-direction:column; align-items:flex-start; align-self:center; gap:var(--s-2); min-width:0; }
.inspiration-feature-label { color:var(--accent); font:500 var(--fs-label-xs)/var(--lh-label) var(--font-sans); letter-spacing:.04em; }
.inspiration-feature-copy h2 { margin:0; color:var(--text-primary); font:500 clamp(22px,2vw,30px)/1.35 var(--font-display); letter-spacing:-.035em; }
.inspiration-feature-copy p { margin:0; color:var(--text-secondary); font-size:var(--fs-label-sm); line-height:var(--lh-body); }
.inspiration-feature-actions { display:flex; flex-wrap:wrap; align-items:center; gap:var(--s-1) var(--s-3); margin-top:var(--s-2); }
.inspiration-feature-draw { justify-content:center; min-height:var(--control-height-sm); padding:var(--s-2) var(--s-3); font-size:var(--fs-label-sm); }
@media (max-width:900px) {
  .inspiration-deck-stage { grid-template-columns:repeat(var(--inspiration-side-count),minmax(0,1fr)); }
  .inspiration-feature { grid-column:1/-1; }
  .inspiration-deck-card:not(.front) { grid-template-columns:minmax(80px,.6fr) minmax(0,1fr); grid-template-rows:minmax(0,1fr); height:160px; gap:var(--s-3); }
  .inspiration-deck-copy { grid-template-columns:minmax(0,1fr); align-content:center; padding:0; }
  .inspiration-deck-copy .inspiration-deck-open { grid-column:1; grid-row:auto; }
}
@media (max-width:700px) {
  .inspiration-deck-stage { grid-template-columns:minmax(0,1fr); gap:var(--s-3); }
  .inspiration-feature { gap:var(--s-2); padding:var(--s-3); }
  .inspiration-deck-card:not(.front) { height:140px; }
}
@media (prefers-reduced-motion:reduce) { .inspiration-deck-card.front { transition:none; } }
:global(:root:is([data-motion='reduce'],[data-motion='reduced'])) .inspiration-deck-card.front { transition:none; }
</style>
