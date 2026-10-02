<template>
  <section v-if="rails.length" class="inspiration-deck" aria-label="翻阅灵感推荐">
    <div class="inspiration-deck-intro">
      <span class="inspiration-deck-kicker"><ArchiveIcon name="spark" /> 灵感手帖</span>
      <p :id="hintId">轻拨一页，遇见下一幕</p>
      <div class="inspiration-deck-controls">
        <button type="button" aria-label="上一张灵感" :disabled="rails.length < 2" @click="step(-1)">
          <ArchiveIcon name="chevron-down" class="previous-icon" />
        </button>
        <span class="inspiration-deck-count" role="status" aria-live="polite" aria-atomic="true">
          <span aria-hidden="true">{{ String(index + 1).padStart(2, '0') }} / {{ String(rails.length).padStart(2, '0') }}</span>
          <span class="sr-only">第 {{ index + 1 }} 张，共 {{ rails.length }} 张：{{ rails[index]?.title }}</span>
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
        <span class="inspiration-deck-seal" aria-hidden="true"><ArchiveIcon :name="railIconName(item.rail.icon)" /></span>
        <div class="inspiration-deck-copy">
          <h2>{{ item.rail.title }}</h2>
          <p>{{ item.rail.subtitle }}</p>
          <button class="mood-rail inspiration-deck-open" type="button" :disabled="Boolean(turning)"
            :aria-label="'探索：' + item.rail.title" @click="emit('select', item.rail)">
            探索这一页 <ArchiveIcon name="chevron-down" class="next-icon" />
          </button>
        </div>
        <span class="inspiration-deck-corner" aria-hidden="true"><ArchiveIcon name="star" /></span>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { railIconName } from '@/composables/scene/sceneExplorerPresentation'
import { useInspirationDeck } from '@/composables/scene/useInspirationDeck'

interface MoodRail { character: string; icon?: string; title: string; subtitle: string; query: string }
const props = defineProps<{ rails: MoodRail[] }>()
const emit = defineEmits<{ select: [rail: MoodRail] }>()
const hintId = useId()
const host = ref<HTMLElement | null>(null)
const entries = computed(() => props.rails.map((rail, i) => ({ rail, key: `${i}:${rail.title}:${rail.query}` })))
const keys = computed(() => entries.value.map(item => item.key))
const { index, dragX, dragging, turning, resetting, canAnimate, step, pointerDown, pointerMove,
  pointerUp, cancel, clickCapture, keydown } = useInspirationDeck(host, () => keys.value)
const cards = computed(() => Array.from({ length: Math.min(3, entries.value.length) }, (_, depth) => {
  const offset = depth * (turning.value === -1 ? -1 : 1)
  return entries.value[(index.value + offset + entries.value.length) % entries.value.length]
}))
function cardTransform(depth: number): string {
  const lift = turning.value && depth > 0 ? depth - 1 : depth
  const x = depth === 0 ? (turning.value ? -turning.value * 100 : canAnimate.value ? dragX.value : 0) : lift * 7
  const rotation = depth === 0 ? Math.max(-1.5, Math.min(1.5, x / 40)) : lift * 1.6
  return `translate3d(${x}px, ${lift * -7}px, 0) rotate(${rotation}deg) scale(${1 - lift * .025})`
}
</script>

<style scoped>
.inspiration-deck-card { transform:var(--deck-transform); opacity:var(--deck-opacity); z-index:var(--deck-z); }
.inspiration-deck { grid-area:moods; display:grid; grid-template-columns:minmax(150px,.45fr) minmax(0,1fr); align-items:center; gap:var(--s-4); min-width:0; padding:var(--s-3) var(--s-4) var(--s-4) 0; }
.inspiration-deck-intro { min-width:0; }
.inspiration-deck-kicker { display:flex; align-items:center; gap:var(--s-2); color:var(--accent); font-size:var(--fs-label); font-weight:600; }
.inspiration-deck-intro p { margin:var(--s-2) 0; color:var(--text-secondary); font-size:var(--fs-label-sm); }
.inspiration-deck-controls { display:flex; align-items:center; gap:var(--s-2); }
.inspiration-deck-controls button { display:grid; place-items:center; width:36px; height:36px; border:1px solid var(--border-strong); border-radius:var(--r-pill); color:var(--text-secondary); background:var(--bg-surface); cursor:pointer; }
.inspiration-deck-controls button:hover { color:var(--accent); border-color:var(--accent); }
.inspiration-deck-controls button:disabled, .inspiration-deck-open:disabled { color:var(--text-disabled); cursor:default; }
.inspiration-deck-count { color:var(--text-muted); font:500 var(--fs-label-sm)/1 var(--font-mono); font-variant-numeric:tabular-nums; }
.previous-icon { transform:rotate(90deg); }
.next-icon { transform:rotate(-90deg); }
.inspiration-deck-stage { display:grid; position:relative; min-width:0; isolation:isolate; touch-action:pan-y; cursor:grab; border-radius:var(--r-lg); }
.inspiration-deck-stage.dragging { cursor:grabbing; user-select:none; }
.inspiration-deck-card { grid-area:1/1; display:flex; align-items:center; gap:var(--s-3); position:relative; min-width:0; padding:var(--s-4); border:1px solid color-mix(in srgb,var(--card-accent,var(--accent)) 38%,var(--border-soft)); border-radius:var(--r-lg); background:var(--bg-surface); box-shadow:var(--shadow-sm); transform-origin:65% 80%; transition:transform 240ms var(--ease-out),opacity 240ms var(--ease-out); }
.inspiration-deck-card[data-character="nene"] { --card-accent:var(--nene-violet); }
.inspiration-deck-card[data-character="natsume"] { --card-accent:var(--natsume-amber); }
.inspiration-deck-seal { display:grid; place-items:center; flex:none; width:58px; height:68px; border:1px solid color-mix(in srgb,var(--card-accent,var(--accent)) 45%,var(--border-soft)); border-radius:50% 50% var(--r-md) var(--r-md); color:var(--card-accent,var(--accent)); background:color-mix(in srgb,var(--card-accent,var(--accent)) 7%,var(--bg-surface)); }
.inspiration-deck-seal .archive-icon { width:30px; height:30px; }
.inspiration-deck-copy { min-width:0; }
.inspiration-deck-copy h2 { margin:0; color:var(--text-primary); font:500 var(--fs-body)/var(--lh-body) var(--font-display); overflow-wrap:anywhere; }
.inspiration-deck-copy p { margin:var(--s-1) 0 var(--s-2); color:var(--text-secondary); font-size:var(--fs-label-sm); overflow-wrap:anywhere; }
.inspiration-deck-open { display:inline-flex; align-items:center; gap:var(--s-1); min-height:30px; padding:0; border:0; background:transparent; color:var(--card-accent,var(--accent)); font:600 var(--fs-label-sm)/var(--lh-body) var(--font-sans); cursor:pointer; }
.inspiration-deck-open:hover { text-decoration:underline; text-underline-offset:4px; }
.inspiration-deck-corner { margin-left:auto; align-self:flex-start; color:var(--card-accent,var(--accent)); }
.inspiration-deck-stage:focus-visible, .inspiration-deck button:focus-visible { outline:2px solid var(--accent); outline-offset:4px; }
.inspiration-deck-stage.dragging .front, .inspiration-deck-stage.still .inspiration-deck-card { transition:none; }
@media (prefers-reduced-motion:reduce) { .inspiration-deck-card { transition:none; } }
</style>
