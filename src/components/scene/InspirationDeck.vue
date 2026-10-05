<template>
  <section v-if="rails.length" class="inspiration-deck" aria-label="翻阅灵感推荐">
    <div class="inspiration-notebook">
    <div class="inspiration-deck-intro">
      <span class="inspiration-deck-kicker"><ArchiveIcon name="spark" /> 灵感手帖</span>
      <p :id="hintId" class="sr-only">左右方向键翻页，也可拖动卡片。按 Tab 移到探索场景。</p>
      <div class="inspiration-deck-controls">
        <kbd class="inspiration-deck-keys" aria-hidden="true">← →</kbd>
        <button type="button" aria-label="上一张灵感" :disabled="rails.length < 2" @click="step(-1)">
          <ArchiveIcon name="chevron-down" class="previous-icon" />
        </button>
        <span class="inspiration-deck-count" role="status" aria-live="polite" aria-atomic="true">
          <span aria-hidden="true">{{ String(index + 1).padStart(2, '0') }} / {{ String(rails.length).padStart(2, '0') }}</span>
          <span class="sr-only">第 {{ index + 1 }} 张，共 {{ rails.length }} 张：{{ entries[index]?.scene?.title || rails[index]?.title }}</span>
        </span>
        <button type="button" aria-label="下一张灵感" :disabled="rails.length < 2" @click="step(1)">
          <ArchiveIcon name="chevron-down" class="next-icon" />
        </button>
      </div>
    </div>
    <div ref="host" class="inspiration-deck-stage" tabindex="0" role="group" aria-label="灵感卡片，左右方向键翻页"
      :aria-describedby="hintId" :class="{ dragging, still: !canAnimate || resetting }"
      @pointerdown="pointerDown" @pointermove="pointerMove" @pointerup="pointerUp"
      @pointercancel="cancel" @lostpointercapture="cancel" @keydown="keydown" @click.capture="clickCapture"
      @pointerleave="!dragging && cancel()" @dragstart.prevent>
      <article v-for="(item, depth) in cards" :key="item.key" class="inspiration-deck-card"
        :class="{ front: depth === 0 }" :data-character="item.rail.character"
        :style="{ '--deck-transform': cardTransform(depth), '--deck-opacity': depth === 0 && turning ? 0 : 1, '--deck-z': 3 - depth }" :inert="depth !== 0" :aria-hidden="depth !== 0">
        <InspirationArtwork :scene="depth === 0 ? item.scene : undefined" :icon="railIconName(item.rail.icon)" />
        <div class="inspiration-deck-copy">
          <span class="inspiration-deck-subtitle">{{ item.rail.subtitle }}</span>
          <h2>{{ item.scene?.title || item.rail.title }}</h2>
          <button class="mood-rail inspiration-deck-open" type="button" :disabled="Boolean(turning)"
            :aria-label="'探索：' + item.rail.title" @click="emit('select', item.rail)">
            探索场景 <ArchiveIcon name="chevron-down" class="next-icon" />
          </button>
        </div>
      </article>
    </div>
    </div>
    <section v-if="currentEntry" class="inspiration-feature" aria-label="当前灵感完整作品">
      <div class="inspiration-feature-copy">
        <span class="inspiration-feature-label">{{ currentEntry.scene ? sceneCharacter(currentEntry.scene) : '灵感手帖' }}</span>
        <h2>{{ currentEntry.scene?.title || currentEntry.rail.title }}</h2>
        <p>{{ currentEntry.rail.subtitle }}</p>
        <div class="inspiration-feature-actions">
          <RouterLink v-if="currentEntry.scene" class="btn btn-primary inspiration-feature-draw" :to="'/prompt-builder?scene=' + encodeURIComponent(currentEntry.scene.id)"><ArchiveIcon name="spark" />用这一幕绘制</RouterLink>
          <button v-if="currentEntry.scene" class="btn btn-ghost" type="button" @click="emit('open', currentEntry.scene)"><ArchiveIcon name="image" />查看场景</button>
          <button v-else class="btn btn-ghost" type="button" @click="emit('select', currentEntry.rail)">探索场景<ArchiveIcon name="chevron-down" class="next-icon" /></button>
        </div>
      </div>
      <button class="inspiration-feature-image" type="button" :disabled="!currentEntry.scene" :aria-label="currentEntry.scene ? '查看完整场景：' + currentEntry.scene.title : '此灵感暂未提供场景图片'" @click="currentEntry.scene && emit('open', currentEntry.scene)">
        <InspirationArtwork :scene="currentEntry.scene" :icon="railIconName(currentEntry.rail.icon)" full />
      </button>
    </section>
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
// Reuse the catalog already in view and the same thumb URLs as SceneCard.
// A rail without a matching All-rated scene keeps its text fallback; no catalog fetch.
const entries = computed(() => props.rails.map((rail, i) => {
  const analysis = analyzeQuery(rail.query, null)
  let scene: ExplorerScene | undefined, bestScore = -Infinity
  // Only the best match is displayed. Score each candidate once and retain
  // the first tie, matching the previous stable sort without sorting the catalog.
  for (const candidate of props.scenes) {
    if (candidate.rating !== 'All' || candidate.mature === true
      || (rail.character !== 'shared' && candidate.char !== rail.character)
      || !matchesSearch(candidate, rail.query, null, undefined, analysis)) continue
    const score = searchScore(candidate, rail.query, null, undefined, analysis)
    if (score > bestScore) { scene = candidate; bestScore = score }
  }
  return { rail, scene, key: `${i}:${rail.title}:${rail.query}` }
}))
const keys = computed(() => entries.value.map(item => item.key))
const { index, dragX, dragging, turning, resetting, canAnimate, step, pointerDown, pointerMove,
  pointerUp, cancel, clickCapture, keydown } = useInspirationDeck(host, () => keys.value)
const currentEntry = computed(() => entries.value[index.value])
function sceneCharacter(scene: ExplorerScene) { return scene.char === 'natsume' ? '四季夏目' : scene.char === 'nene' ? '绫地宁宁' : '双人场景' }
const cards = computed(() => Array.from({ length: Math.min(3, entries.value.length) }, (_, depth) => {
  const offset = depth * (turning.value === -1 ? -1 : 1)
  return entries.value[(index.value + offset + entries.value.length) % entries.value.length]
}))
function cardTransform(depth: number): string {
  const lift = turning.value && depth > 0 ? depth - 1 : depth
  const x = depth === 0 ? (turning.value ? -turning.value * 100 : canAnimate.value ? dragX.value : 0) : lift * 7
  const rotation = depth === 0 ? Math.max(-1.5, Math.min(1.5, x / 40)) : lift * .6
  return `translate3d(${x}px, ${lift * -4}px, 0) rotate(${rotation}deg) scale(${1 - lift * .025})`
}
</script>

<style scoped>
.inspiration-deck-card { transform:var(--deck-transform); opacity:var(--deck-opacity); z-index:var(--deck-z); }
.inspiration-deck { grid-area:moods; position:relative; display:grid; grid-template-columns:minmax(220px,290px) minmax(0,1fr); align-items:stretch; gap:var(--s-5); width:100%; min-width:0; }
.inspiration-notebook { min-width:0; align-self:start; padding:var(--s-4); border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--bg-surface); box-shadow:inset 0 1px 0 var(--glass-highlight); }
.inspiration-deck-intro { display:flex; align-items:center; justify-content:space-between; gap:var(--s-2); min-width:0; margin-bottom:var(--s-4); }
.inspiration-deck-kicker { display:flex; align-items:center; gap:var(--s-1); color:var(--text-secondary); font-size:var(--fs-label-xs); font-weight:600; white-space:nowrap; }
.inspiration-deck-kicker .archive-icon { width:14px; height:14px; }
.inspiration-deck-controls { display:flex; align-items:center; gap:var(--s-1); }
.inspiration-deck-keys { display:none; }
.inspiration-deck-controls button { display:grid; place-items:center; width:var(--control-height-sm); height:var(--control-height-sm); border:1px solid var(--border-soft); border-radius:var(--r-sm); color:var(--text-secondary); background:var(--bg-surface); cursor:pointer; }
.inspiration-deck-controls button:hover { color:var(--accent); border-color:var(--accent); }
.inspiration-deck-controls button:active { transform:scale(.94); }
.inspiration-deck-controls button:disabled, .inspiration-deck-open:disabled { color:var(--text-disabled); cursor:default; }
.inspiration-deck-count { color:var(--text-muted); font:500 var(--fs-label-xs)/1 var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
.previous-icon { transform:rotate(90deg); }
.next-icon { transform:rotate(-90deg); }
.inspiration-deck-stage { display:grid; position:relative; min-width:0; isolation:isolate; touch-action:pan-y; cursor:grab; border-radius:var(--r-lg); }
.inspiration-deck-stage.dragging { cursor:grabbing; user-select:none; }
.inspiration-deck-card { --inspiration-art-height:clamp(140px,20dvh,215px); grid-area:1/1; display:grid; align-items:center; gap:var(--s-3); position:relative; min-width:0; padding:var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--bg-surface); box-shadow:var(--shadow-sm); transform-origin:65% 80%; transition:transform 240ms var(--ease-out),opacity 240ms var(--ease-out); }
.inspiration-deck-copy { display:flex; flex-direction:column; align-items:flex-start; min-width:0; }
.inspiration-deck-subtitle { margin-bottom:var(--s-2); color:var(--text-muted); font-size:var(--fs-label-xs); }
.inspiration-deck-copy h2 { max-width:100%; margin:0; color:var(--text-primary); font:600 var(--fs-body)/var(--lh-body) var(--font-display); letter-spacing:-.02em; }
.inspiration-deck-open { display:inline-flex; align-items:center; gap:var(--s-2); min-height:var(--control-height-sm); margin-top:var(--s-1); padding:0 var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-sm); background:var(--bg-surface); color:var(--accent); font:600 var(--fs-label-sm)/var(--lh-body) var(--font-sans); cursor:pointer; }
.inspiration-deck-open:hover { background:var(--accent-soft); border-color:var(--accent); }
.inspiration-deck-open:active { transform:translateY(1px); }
.inspiration-deck-stage:focus-visible, .inspiration-deck button:focus-visible { outline:2px solid var(--accent); outline-offset:4px; }
.inspiration-deck-stage.dragging .front, .inspiration-deck-stage.still .inspiration-deck-card { transition:none; }
.inspiration-feature { display:grid; grid-template-columns:minmax(160px,.48fr) minmax(0,1fr); grid-template-rows:minmax(0,1fr); align-items:center; gap:var(--s-4); min-width:0; min-height:0; padding:var(--s-5); border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--bg-surface); box-shadow:inset 0 1px 0 var(--glass-highlight); }
.inspiration-feature-copy { display:flex; flex-direction:column; align-items:flex-start; gap:var(--s-3); min-width:0; padding-left:var(--s-2); }
.inspiration-feature-label { color:var(--accent); font:500 var(--fs-label-xs)/var(--lh-label) var(--font-sans); letter-spacing:.08em; }
.inspiration-feature-copy h2 { max-width:250px; margin:0; color:var(--text-primary); font:500 clamp(22px,2.2vw,34px)/1.4 var(--font-display); letter-spacing:-.035em; }
.inspiration-feature-copy p { margin:0; color:var(--text-secondary); font-size:var(--fs-label-sm); line-height:var(--lh-body); }
.inspiration-feature-actions { display:grid; gap:var(--s-2); width:100%; max-width:220px; margin-top:var(--s-2); }
.inspiration-feature-actions .btn { justify-content:center; }
.inspiration-feature-image { display:flex; align-items:center; justify-content:center; width:100%; height:clamp(300px,48dvh,520px); min-width:0; min-height:0; padding:0; border:0; border-radius:var(--r-sm); background:transparent; cursor:zoom-in; }
.inspiration-feature-image:disabled { cursor:default; color:var(--text-disabled); }
.inspiration-feature :is(button,a):focus-visible { outline:2px solid var(--accent); outline-offset:4px; }
@media (max-width:1100px) {
  .inspiration-deck { grid-template-columns:220px minmax(0,1fr); gap:var(--s-4); }
  .inspiration-feature { display:flex; flex-direction:column-reverse; gap:var(--s-3); padding:var(--s-4); }
  .inspiration-feature-image { flex:none; height:clamp(250px,42dvh,390px); }
  .inspiration-feature-copy { align-items:center; gap:var(--s-2); width:100%; padding:0; text-align:center; }
  .inspiration-feature-copy h2 { max-width:none; font-size:var(--fs-title-sm); }
  .inspiration-feature-label,.inspiration-feature-copy p { display:none; }
  .inspiration-feature-actions { display:flex; justify-content:center; max-width:none; margin:0; }
  .inspiration-feature-actions .btn { min-height:var(--control-height-sm); font-size:var(--fs-label-sm); }
}
@media (max-width:700px) {
  .inspiration-deck { grid-template-columns:minmax(0,1fr); }
  .inspiration-notebook { padding:var(--s-3); }
  .inspiration-deck-card { grid-template-columns:72px minmax(0,1fr); --inspiration-art-height:100px; }
  .inspiration-deck-copy h2 { font-size:var(--fs-label-sm); }
}
@media (prefers-reduced-motion:reduce) { .inspiration-deck-card { transition:none; } }
:global(:root:is([data-motion='reduce'],[data-motion='reduced'])) .inspiration-deck-card { transition:none; }
</style>
