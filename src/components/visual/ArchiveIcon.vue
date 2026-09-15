<template>
  <svg
    class="archive-icon"
    :data-icon="name"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.65"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path v-for="(path, index) in def.paths" :key="index" :d="path" />
  </svg>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { ArchiveIconDef, ArchiveIconName } from './icons/types.ts'
import { navDefs } from './icons/nav.ts'
import { statusDefs } from './icons/status.ts'
import { emotionDefs } from './icons/emotion.ts'
import { characterDefs } from './icons/character.ts'
import { cameraDefs } from './icons/camera.ts'
import { lightingDefs } from './icons/lighting.ts'
import { compositionDefs } from './icons/composition.ts'
import { motifDefs } from './icons/motif.ts'
import { toolDefs } from './icons/tool.ts'

const ICON_DEFS = {
  ...navDefs,
  ...statusDefs,
  ...emotionDefs,
  ...characterDefs,
  ...cameraDefs,
  ...lightingDefs,
  ...compositionDefs,
  ...motifDefs,
  ...toolDefs,
} satisfies Record<string, ArchiveIconDef>

export type { ArchiveIconName } from './icons/types.ts'
const props = defineProps<{ name: ArchiveIconName }>()
// 老存档中的图标名可能已失效；文字和操作仍应正常呈现。
const def = computed(() => Object.hasOwn(ICON_DEFS, props.name) ? ICON_DEFS[props.name] : statusDefs.info)
</script>

<style scoped>
.archive-icon {
  display: inline-block;
  width: 1em;
  height: 1em;
  flex: 0 0 auto;
  vertical-align: -.14em;
  pointer-events: none;
}
</style>
