<template>
  <PromptPreviewContent v-if="tags.length" :prompt="tags.join(', ')" :positive-count="tags.length" :scopes="scopes" negative-text="" label="作品标签">
    <template #token="{ token, tokenClass }"><button type="button" :class="tokenClass" :aria-label="`筛选标签：${token}`" @click="$emit('filter', token)">{{ token }}</button></template>
  </PromptPreviewContent>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import PromptPreviewContent from '@/components/director/PromptPreviewContent.vue'
import { promptPreviewScopes } from '@/utils/promptPreview'
import { artworkTags } from '@/composables/gallery/artworkTags'
import type { ArtworkRecord } from '@/types/artwork'
const props = defineProps<{ artwork: ArtworkRecord }>()
defineEmits<{ filter: [tag: string] }>()
const tags = computed(() => artworkTags(props.artwork))
// Classify saved tags individually so punctuation never changes a filter value.
const scopes = computed(() => {
  const context = { format: 'anima-tags' as const, characterTokens: [], copyrightTokens: [], qualityTokens: [], artists: [] }
  const layers = promptPreviewScopes('', context)[0]!
  for (const tag of tags.value) {
    const classified = promptPreviewScopes(tag, context)[0]!
    const target = classified.find(layer => layer.groups.some(group => group.tokens.length))
    const layer = layers.find(layer => layer.id === (target?.id ?? 'visual'))!
    layer.groups[0]!.tokens.push(tag)
  }
  return [layers.filter(layer => layer.groups.some(group => group.tokens.length))]
})
</script>

<style scoped>
button { cursor:pointer; text-align:start; }
button:hover { text-decoration:underline; text-underline-offset:3px; }
button:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
</style>
