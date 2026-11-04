<template>
  <div class="character-wardrobe">
    <p v-if="!canApply" class="wardrobe-description" role="status">请先选择单个角色，再为她换装。</p>
    <p v-else-if="pb.outfitOverride?.presetId?.startsWith('catalog/') || pb.outfitOverride?.presetId?.startsWith('studio/')" class="wardrobe-description" role="status">
      已换装：{{ pb.outfitOverride.label }}；再次选择可恢复。
    </p>
    <p v-else class="wardrobe-description">选择服装即可替换，再次选择可恢复。</p>
    <div v-if="visible.length" class="outfit-preset-list">
      <button v-for="preset in visible" :key="preset.id" type="button" class="outfit-preset"
        :class="{ selected: pb.outfitOverride?.presetId === preset.id }"
        :aria-pressed="pb.outfitOverride?.presetId === preset.id" :disabled="!canApply" @click="select(preset)">
        <ArchiveIcon name="success" class="tag-option-check" />
        <strong>{{ preset.name }}</strong><small>{{ preset.sourceName }}</small>
      </button>
    </div>
    <p v-else class="wardrobe-description" role="status">没有找到匹配的服装。</p>
    <div v-if="matched.length > visible.length" class="wardrobe-more">
      <span>已显示 {{ visible.length }} / {{ matched.length }} 套</span>
      <button class="btn btn-quiet btn-sm" type="button" @click="limit += 24">显示更多</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { toRef } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { useOutfitPresetLibrary } from '@/composables/prompt/useOutfitPresetLibrary'

const props = defineProps<{ search: string }>()
const { pb, limit, canApply, matched, visible, select } = useOutfitPresetLibrary(toRef(props, 'search'))
</script>
