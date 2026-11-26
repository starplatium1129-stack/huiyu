<template>
  <div class="panel step-panel" id="stepChar">
    <div class="panel-title">角色</div>
    <div class="char-source studio-segments studio-segments--compact" data-fluid-glass role="group" aria-label="角色来源">
      <AnimatedSelection />
      <button type="button" class="char-source-btn"
        :aria-pressed="!pb.isPopular && !pb.isUnbound && pb.castLead?.source !== 'custom'" @click="selectStudio">
        <ArchiveIcon name="character" class="char-source-icon" />
        <span class="char-source-label studio-control-label">工作室角色</span>
      </button>
      <button type="button" class="char-source-btn"
        :aria-pressed="pb.isPopular"
        :aria-busy="popularSourceLoading || undefined"
        @pointerenter="warmPopularSource"
        @focus="warmPopularSource"
        @click="$emit('selectSource', 'popular')">
        <ArchiveIcon name="spark" class="char-source-icon" />
        <span class="studio-control-label"><span class="char-source-label">热门角色</span></span>
      </button>
      <button type="button" class="char-source-btn"
        :aria-pressed="pb.isUnbound" @click="$emit('selectSource', 'none')">
        <ArchiveIcon name="image" class="char-source-icon" />
        <span class="char-source-label studio-control-label">无角色</span>
      </button>
    </div>

    <div v-if="pb.isUnbound" class="character-source-content">
      <p class="tw:text-secondary tw:text-body-sm">自由创作，不绑定角色。</p>
    </div>
    <div v-else-if="!pb.isPopular && pb.cast.length <= 1 && pb.castLead?.source !== 'custom'" v-content-motion:right="!pb.isPopular" class="character-source-content">
      <div class="char-row studio-character-gallery" role="group" aria-label="工作室角色">
        <button v-for="c in charOptions" :key="c.id"
          class="char-btn studio-character-choice" type="button"
          :class="{ active: pb.char === c.id, 'studio-character-natsume': c.id === 'natsume' }"
          :aria-label="c.label"
          :aria-pressed="pb.char === c.id"
          @click="selectStudioCharacter(c.id)">
          <span class="studio-character-art" aria-hidden="true">
            <CharacterPortrait v-if="c.id !== 'natsume'" :src="characterArtEntry('nene')?.thumbnailUrl || neneShelfPortrait" fallback="/assets/characters/nene-portrait.webp" name="宁宁" />
            <CharacterPortrait v-if="c.id !== 'nene'" :src="characterArtEntry('natsume')?.thumbnailUrl || natsumeShelfPortrait" fallback="/assets/characters/natsume-portrait.webp" name="夏目" />
          </span>
          <span class="studio-character-copy"><strong>{{ c.label }}</strong><small>{{ c.id === 'nene' ? '绫地宁宁' : c.id === 'natsume' ? '四季夏目' : '宁宁与夏目' }}</small></span>
          <Transition name="studio-character-check">
            <ArchiveIcon v-if="pb.char === c.id" name="success" class="studio-character-check" />
          </Transition>
        </button>
      </div>
      <p class="studio-traits-label">角色特征</p>
      <div class="traits-row">
        <button v-for="t in currentTraits" :key="t.tag"
          class="trait-chip"
          :class="{ active: pb.manualTags.has(t.tag) }"
          :aria-pressed="pb.manualTags.has(t.tag)"
          type="button"
          @click="pb.toggleManualTag(t.tag)"><span class="studio-control-label">{{ t.label }}</span></button>
      </div>
    </div>

    <div v-else-if="pb.isPopular && pb.cast.length <= 1" v-content-motion:right="pb.isPopular" class="character-source-content">
      <AsyncPanel :loader="loadPopularCharacterPicker" label="热门角色" v-slot="{ component }">
      <component :is="component"
        v-model:search="popularSearch"
        :characters="pb.popularCharacters"
        :selected-character-id="pb.subject.kind === 'popular' ? pb.subject.characterId : ''"
        :selected-outfit-id="pb.subject.kind === 'popular' && !pb.outfitOverride ? pb.subject.outfitId : ''"
        @select="$emit('selectCharacter', $event)"
        @select-outfit="$emit('selectOutfit', $event)"
      />
      </AsyncPanel>
    </div>
    <DirectorCastRoster v-bind="{ engine, canvasSize, sizeManuallySet, customMossLayout }" />
  </div>
</template>

<script setup lang="ts">
import DirectorCastRoster from '@/components/director/DirectorCastRoster.vue'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import neneShelfPortrait from '@/assets/illustrations/nene-portrait-384.webp'
import natsumeShelfPortrait from '@/assets/illustrations/natsume-portrait-384.webp'
import { characterArtEntry } from '@/platform/characterArtState'
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import { charOptions as historicalCharacterOptions } from '@/composables/scene/directorOptions'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import CharacterPortrait from '@/components/library/CharacterPortrait.vue'
import AsyncPanel from '@/components/ui/AsyncPanel.vue'
const loadPopularCharacterPicker = () => import('@/components/popular/PopularCharacterPicker.vue')
import type { PopularCharacter } from '@/utils/popularContent'
import '@/assets/css/director/components/DirectorCharacterPanel.css'

defineProps<{
  engine: string
  canvasSize: string
  sizeManuallySet: boolean
  customMossLayout: boolean
  currentTraits: Array<{ tag: string; label: string }>
  popularSourceLoading?: boolean
}>()

const emit = defineEmits<{
  selectSource: [source: 'studio' | 'popular' | 'none']
  selectCharacter: [character: PopularCharacter]
  selectOutfit: [outfitId: string]
}>()

const pb = usePromptBuilderStore()
let popularWarmed = false
let warmTimer: ReturnType<typeof setTimeout> | undefined
let warmIdle: number | undefined

function warmPopularSource() {
  if (popularWarmed) return
  popularWarmed = true
  if (!pb.popularCharacters.length) void pb.loadPopularCatalog().catch(() => { popularWarmed = false })
  void loadPopularCharacterPicker().catch(() => {})
}

onMounted(() => {
  if (typeof window.requestIdleCallback === 'function') {
    warmIdle = window.requestIdleCallback(() => warmPopularSource(), { timeout: 1200 })
  } else {
    warmTimer = setTimeout(warmPopularSource, 250)
  }
})

onBeforeUnmount(() => {
  if (warmIdle !== undefined && typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(warmIdle)
  if (warmTimer !== undefined) clearTimeout(warmTimer)
})

function selectStudioCharacter(id: typeof charOptions[number]['id']) {
  const slot = pb.cast.findIndex(member => member.source === 'studio' && member.characterId === id)
  if (slot >= 0) pb.selectCastLead(slot)
  else pb.setChar(id)
}
const charOptions=historicalCharacterOptions.filter(character=>character.id!=='triad')
const popularSearch = ref('')

function selectStudio() {
  if (pb.castLead?.source === 'custom') pb.setChar('nene')
  else emit('selectSource', 'studio')
}
</script>
