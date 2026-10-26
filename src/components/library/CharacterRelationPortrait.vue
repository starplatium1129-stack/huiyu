<script setup lang="ts">
import { Handle, Position } from '@vue-flow/core'
import CharacterPortrait from './CharacterPortrait.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import type { RelationPerson } from '@/types/characterRelations'
import type { CharacterProfile } from '@/types/character'
defineProps<{ data: { person: RelationPerson; profile?: CharacterProfile; image: string; selected: boolean; isHighlighted?: boolean } }>()
const emit = defineEmits<{ select: [id: string]; hover: [id: string, enter: boolean]; focus: []; move: [id: string, dx: number, dy: number] }>()
const sides = [Position.Top, Position.Right, Position.Bottom, Position.Left]
function move(event: KeyboardEvent, id: string) {
  if (!event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return
  const delta: Record<string, [number, number]> = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] }
  if (!delta[event.key]) return
  event.preventDefault(); event.stopPropagation()
  emit('move', id, ...delta[event.key])
}
</script>

<template>
  <button class="atlas-portrait nopan" :class="{ 'is-selected': data.selected, 'is-highlighted': data.isHighlighted, 'is-pending': !data.profile }"
    type="button" :aria-pressed="data.selected" :aria-label="`${data.person.name}，${data.profile ? '已收录图鉴' : '原作背景人物'}，查看关系`"
    @click.stop="emit('select', data.person.id)" @mouseenter="emit('hover', data.person.id, true)" @mouseleave="emit('hover', data.person.id, false)"
    @focus="emit('hover', data.person.id, true); emit('focus')" @blur="emit('hover', data.person.id, false)" @keydown="move($event, data.person.id)">
    <CharacterPortrait v-if="data.profile" :src="data.image" :name="data.person.name" />
    <span v-else class="atlas-portrait-placeholder" aria-hidden="true"><ArchiveIcon name="character" /></span>
    <strong>{{ data.person.name }}</strong>
  </button>
  <template v-for="side in sides" :key="side"><Handle :id="`source-${side}`" type="source" :position="side" :connectable="false" /><Handle :id="`target-${side}`" type="target" :position="side" :connectable="false" /></template>
</template>

<style scoped>
.atlas-portrait { display: flex; flex-direction: column; width: 108px; padding: 4px 4px 0; border: 1px solid var(--border-strong); border-radius: 2px; background: var(--bg-surface); color: var(--text-primary); box-shadow: var(--shadow-md); cursor: pointer; transition: transform var(--motion-hover) var(--ease-out); }
.atlas-portrait :deep(.character-portrait) { width: 98px; height: 118px; border: 0; border-radius: 0; }
.atlas-portrait :deep(.character-portrait img) { transform: scale(1.45); transform-origin: 50% 15%; }
.atlas-portrait strong { display: block; width: 100%; padding: 6px 1px; text-align: center; font: 500 13px/1.4 var(--font-sans); overflow-wrap: anywhere; }
.atlas-portrait-placeholder { display: grid; place-items: center; width: 98px; height: 118px; background: var(--bg-elevated); color: var(--text-secondary); font-size: 40px; }
.atlas-portrait.is-pending { border-style: dashed; }
.atlas-portrait.is-selected { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent), var(--shadow-md); }
.atlas-portrait.is-highlighted { transform: translateY(-4px); }
.atlas-portrait:focus-visible { outline: 2px solid var(--focus-color); outline-offset: 6px; }
@media (hover: hover) and (pointer: fine) { .atlas-portrait:hover { transform: translateY(-4px); } }
@media (prefers-reduced-motion: reduce) { :root:not([data-motion='full']) .atlas-portrait { transition: none; transform: none; } }
:root:is([data-motion='reduce'],[data-motion='reduced'],[data-reduced-motion='true']) .atlas-portrait { transition: none; transform: none; }
</style>
