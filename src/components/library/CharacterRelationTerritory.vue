<script setup lang="ts">
import { useId } from 'vue'
import { Handle, Position } from '@vue-flow/core'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { atlasDefs, type AtlasEmblemName } from '@/components/visual/icons/atlas'
import type { AtlasShape } from '@/utils/relationAtlas'
defineProps<{ data: {
  label: string; count: number; dimension: string; active?: boolean; expanded?: boolean; portal?: boolean
  shape: AtlasShape; color: string; emblem: AtlasEmblemName
} }>()
const emit = defineEmits<{ open: [id: string]; hover: [id: string]; focus: [] }>()
const patternId = useId().replaceAll(':', '')
</script>

<template>
  <component :is="data.expanded ? 'div' : 'button'" :type="data.expanded ? undefined : 'button'"
    class="relation-territory nodrag nopan" :class="{ 'is-active': data.active, 'is-expanded': data.expanded, 'is-portal': data.portal }"
    :style="{ width: data.shape.width + 'px', height: data.shape.height + 'px', '--territory-color': data.color }"
    :aria-label="data.expanded ? undefined : `${data.portal ? '前往' : '展开'}${data.label}，${data.count} 位人物`" :aria-hidden="data.expanded || undefined"
    @click.stop="!data.expanded && emit('open', data.label)"
    @mouseenter="!data.expanded && emit('hover', data.label)" @mouseleave="emit('hover', '')"
    @focus="emit('hover', data.label); emit('focus')" @blur="emit('hover', '')">
    <svg class="territory-ground" :viewBox="`0 0 ${data.shape.width} ${data.shape.height}`" aria-hidden="true">
      <defs><pattern :id="patternId" width="12" height="12" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r=".85" fill="currentColor" /></pattern></defs>
      <g class="territory-cells"><polygon v-for="(cell, i) in data.shape.cells" :key="i" :points="cell.points" /></g>
      <g class="territory-grain"><polygon v-for="(cell, i) in data.shape.cells" :key="i" :points="cell.points" :fill="`url(#${patternId})`" /></g>
      <path class="territory-boundary" :d="data.shape.outline" />
    </svg>
    <ArchiveIcon class="territory-emblem" name="character" :definition="atlasDefs[data.emblem]" />
    <span class="territory-nameplate">
      <span class="territory-overline">{{ data.portal ? '前往' : data.dimension }}</span>
      <strong>{{ data.label }}</strong>
      <span class="territory-count"><span class="territory-count-line" />{{ data.count }} 位人物<ArchiveIcon v-if="data.portal" class="territory-go" name="chevron-down" /></span>
    </span>
  </component>
  <Handle v-if="!data.expanded" type="source" :position="Position.Right" :connectable="false" />
  <Handle v-if="!data.expanded" type="target" :position="Position.Left" :connectable="false" />
</template>

<style scoped>
.relation-territory { position: relative; display: block; padding: 0; border: 0; background: transparent; color: var(--territory-color); text-align: left; cursor: pointer; isolation: isolate; transition: transform var(--motion-control) var(--ease-out); }
.territory-ground { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.territory-cells polygon { fill: color-mix(in srgb, var(--territory-color) 12%, var(--bg-base)); stroke: color-mix(in srgb, var(--territory-color) 24%, transparent); stroke-width: 1; }
.territory-grain { opacity: .22; }
.territory-boundary { fill: none; stroke: var(--territory-color); stroke-width: 2; }
.relation-territory .territory-emblem { position: absolute; z-index: 1; left: 50%; top: 40%; width: 52%; height: 52%; transform: translate(-50%, -50%); stroke-width: .85; opacity: .42; pointer-events: none; }
.territory-nameplate { position: absolute; z-index: 2; left: 6%; bottom: -12px; display: grid; gap: 3px; min-width: 172px; max-width: 300px; padding: 10px 16px 11px; border-left: 3px solid var(--territory-color); background: var(--bg-elevated); color: var(--text-primary); box-shadow: var(--shadow-md); }
.territory-overline { color: var(--text-secondary); font: 500 10px/1.3 var(--font-sans); letter-spacing: .18em; }
.territory-nameplate strong { font: 600 25px/1.3 var(--font-serif); overflow-wrap: anywhere; }
.territory-count { display: flex; align-items: center; gap: 10px; color: var(--text-secondary); font: 500 11px/1.4 var(--font-sans); font-variant-numeric: tabular-nums; }
.territory-count-line { height: 2px; width: 38px; background: var(--territory-color); }
.territory-go { transform: rotate(-90deg); }
.relation-territory.is-active { transform: translateY(-5px); }
.relation-territory.is-active .territory-boundary { stroke-width: 3; }
.relation-territory:active { transform: translateY(-1px); }
.relation-territory:focus-visible { outline: 2px solid var(--focus-color); outline-offset: 14px; }
.relation-territory.is-expanded { pointer-events: none; }
.is-expanded .territory-cells polygon { fill: color-mix(in srgb, var(--territory-color) 7%, var(--bg-base)); }
.is-expanded .territory-emblem { width: 72%; height: 72%; opacity: .13; }
.is-expanded .territory-nameplate { left: auto; right: -50px; bottom: auto; top: -62px; }
.is-expanded .territory-boundary { stroke-width: 1.5; opacity: .65; }
.is-portal .territory-nameplate strong { font-size: 21px; }
@media (prefers-reduced-motion: reduce) { :root:not([data-motion='full']) .relation-territory { transition: none; transform: none; } }
:root:is([data-motion='reduce'],[data-motion='reduced'],[data-reduced-motion='true']) .relation-territory { transition: none; transform: none; }
@media (forced-colors: active) { .territory-boundary { stroke: CanvasText; } .territory-nameplate { background: Canvas; border-color: Highlight; } }
</style>
