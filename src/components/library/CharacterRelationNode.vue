<script setup lang="ts">
import { Handle, Position } from '@vue-flow/core'
import type { RelationPerson } from '@/types/characterRelations'
import type { CharacterProfile } from '@/types/character'
import CharacterPortrait from './CharacterPortrait.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'

defineProps<{
  data: {
    person: RelationPerson
    profile?: CharacterProfile
    image: string
    selected: boolean
    center: boolean
    isDimmed?: boolean
    isHighlighted?: boolean
  }
}>()

const emit = defineEmits<{
  select: [id: string]
  hover: [id: string, enter: boolean]
}>()

const sides = [Position.Top, Position.Right, Position.Bottom, Position.Left]
</script>

<template>
  <div
    class="relation-person"
    :class="{
      'is-pending': !data.profile,
      'is-center': data.center,
      'is-dimmed': data.isDimmed,
      'is-highlighted': data.isHighlighted,
    }"
    role="button"
    tabindex="0"
    :aria-pressed="data.selected"
    :aria-label="`${data.person.name}，${data.profile ? '已收录档案' : '待补档案'}，查看人物关系`"
    @click.stop="emit('select', data.person.id)"
    @mouseenter="emit('hover', data.person.id, true)"
    @mouseleave="emit('hover', data.person.id, false)"
    @keydown.enter.prevent.stop="emit('select', data.person.id)"
    @keydown.space.prevent.stop="emit('select', data.person.id)"
  >
    <CharacterPortrait v-if="data.profile" :src="data.image" :name="data.person.name" />
    <span v-else class="relation-placeholder" aria-hidden="true"><ArchiveIcon name="character" /></span>
    <span class="relation-person-copy">
      <strong>{{ data.person.name }}</strong>
      <small>{{ data.profile ? (data.center ? '当前中心' : '已收录档案') : '待补档案' }}</small>
    </span>
  </div>
  <template v-for="side in sides" :key="side">
    <Handle :id="`source-${side}`" type="source" :position="side" :connectable="false" />
    <Handle :id="`target-${side}`" type="target" :position="side" :connectable="false" />
  </template>
</template>

<style scoped>
.relation-person {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  width: 190px;
  min-height: 92px;
  padding: var(--s-3);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-lg);
  background: var(--bg-surface);
  color: var(--text-primary);
  text-align: left;
  cursor: grab;
  user-select: none;
  box-shadow: var(--shadow-sm);
  transition: border-color var(--motion-hover) var(--ease-out),
              box-shadow var(--motion-hover) var(--ease-out),
              transform var(--motion-hover) var(--ease-out),
              opacity var(--motion-hover) var(--ease-out),
              background-color var(--motion-hover) var(--ease-out);
}
.relation-person:active {
  cursor: grabbing;
}
@media (hover: hover) and (pointer: fine) {
  .relation-person:hover {
    border-color: var(--border-hover, var(--text-secondary));
    box-shadow: var(--shadow-md);
    transform: translateY(-2px);
  }
}
.relation-person.is-pending {
  border-style: dashed;
  background: color-mix(in srgb, var(--bg-surface) 90%, transparent);
}
@media (hover: hover) and (pointer: fine) {
  .relation-person.is-pending:hover {
    border-color: var(--accent);
  }
}
.relation-person.is-center {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent-soft), 0 0 14px var(--accent-glow), var(--shadow-sm);
}
.relation-person[aria-pressed='true'] {
  box-shadow: 0 0 0 2px var(--accent), var(--selection-shadow);
  border-color: var(--accent);
}
.relation-person.is-dimmed {
  opacity: 0.22;
  filter: grayscale(35%);
  transform: scale(0.97);
}
.relation-person.is-highlighted {
  opacity: 1;
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent-soft), 0 0 16px var(--accent-glow), var(--shadow-md);
  transform: translateY(-2px) scale(1.02);
}
.relation-person:focus-visible {
  outline: 2px solid var(--focus-color);
  outline-offset: 3px;
}
.relation-person-copy {
  display: grid;
  gap: var(--s-1);
  min-width: 0;
}
.relation-person-copy strong {
  font: 600 var(--fs-body-sm)/var(--lh-label) var(--font-sans);
  overflow-wrap: anywhere;
}
.relation-person-copy small {
  color: var(--text-secondary);
  font: 400 var(--fs-label-xs)/var(--lh-label) var(--font-sans);
}
.relation-person.is-center .relation-person-copy small {
  color: var(--accent);
  font-weight: 500;
}
.relation-placeholder {
  display: grid;
  place-items: center;
  flex: none;
  width: 48px;
  height: 60px;
  border-radius: var(--r-md);
  background: var(--bg-elevated);
  color: var(--text-secondary);
}
</style>
