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
      <div class="char-row">
        <button v-for="c in charOptions" :key="c.id"
          class="char-btn" type="button"
          :class="{ active: pb.char === c.id }"
          :aria-pressed="pb.char === c.id"
          @click="pb.setChar(c.id)">
          <ArchiveIcon :name="c.iconName" /> {{ c.label }}
        </button>
      </div>
      <div class="traits-row">
        <button v-for="t in currentTraits" :key="t.tag"
          class="trait-chip"
          :class="{ active: pb.manualTags.has(t.tag) }"
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
