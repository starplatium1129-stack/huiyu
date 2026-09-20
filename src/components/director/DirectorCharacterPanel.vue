<template>
  <div class="panel step-panel" id="stepChar">
    <div class="panel-title">角色 · Character</div>
    <div class="char-source" role="group" aria-label="角色来源">
      <button type="button" class="char-source-btn" :class="{ active: !pb.isPopular }"
        :aria-pressed="!pb.isPopular" @click="$emit('selectSource', 'studio')">
        <ArchiveIcon name="character" class="char-source-icon" />
        <span>工作室角色</span>
      </button>
      <button type="button" class="char-source-btn" :class="{ active: pb.isPopular }"
        :aria-pressed="pb.isPopular" @click="$emit('selectSource', 'popular')">
        <ArchiveIcon name="spark" class="char-source-icon" />
        <span>热门角色<span class="char-source-note"> · 无需 LoRA</span></span>
      </button>
    </div>

    <template v-if="!pb.isPopular">
      <div class="char-row studio-character-gallery" role="group" aria-label="工作室角色">
        <button v-for="c in charOptions" :key="c.id"
          class="char-btn studio-character-choice" type="button"
          :class="{ active: pb.char === c.id, 'studio-character-duet': c.id === 'triad', 'studio-character-natsume': c.id === 'natsume' }"
          :aria-label="c.label"
          :aria-pressed="pb.char === c.id"
          @click="pb.setChar(c.id)">
          <span class="studio-character-art" :class="{ 'studio-duet-art': c.id === 'triad' }" aria-hidden="true">
            <CharacterPortrait v-if="c.id !== 'natsume'" src="/assets/characters/nene-home-cg-512.webp" name="宁宁" />
            <CharacterPortrait v-if="c.id !== 'nene'" src="/assets/characters/natsume-home-cg-512.webp" name="夏目" />
          </span>
          <span class="studio-character-copy"><strong>{{ c.label }}</strong><small>{{ c.id === 'nene' ? '绫地宁宁' : c.id === 'natsume' ? '四季夏目' : '宁宁与夏目' }}</small></span>
          <ArchiveIcon v-if="pb.char === c.id" name="success" class="studio-character-check" />
        </button>
      </div>
      <p class="studio-traits-label">角色特征</p>
      <div class="traits-row">
        <button v-for="t in currentTraits" :key="t.tag"
          class="trait-chip"
          :class="{ active: pb.manualTags.has(t.tag) }"
          :aria-pressed="pb.manualTags.has(t.tag)"
          type="button"
          @click="pb.toggleManualTag(t.tag)">{{ t.label }}</button>
      </div>
    </template>

    <template v-else>
      <PopularCharacterPicker
        v-model:search="popularSearch"
        :characters="pb.popularCharacters"
        :selected-character-id="pb.subject.kind === 'popular' ? pb.subject.characterId : ''"
        :selected-outfit-id="pb.subject.kind === 'popular' ? pb.subject.outfitId : ''"
        @select="$emit('selectCharacter', $event)"
        @select-outfit="$emit('selectOutfit', $event)"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, defineAsyncComponent } from 'vue'
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import { charOptions } from '@/composables/scene/directorOptions'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
const CharacterPortrait = defineAsyncComponent(() => import('@/components/library/CharacterPortrait.vue'))
const PopularCharacterPicker = defineAsyncComponent(() => import('@/components/popular/PopularCharacterPicker.vue'))
import type { PopularCharacter } from '@/utils/popularContent'
import '@/assets/css/director/components/DirectorCharacterPanel.css'

defineProps<{
  currentTraits: Array<{ tag: string; label: string }>
}>()

defineEmits<{
  selectSource: [source: 'studio' | 'popular']
  selectCharacter: [character: PopularCharacter]
  selectOutfit: [outfitId: string]
}>()

const pb = usePromptBuilderStore()
const popularSearch = ref('')
</script>
