<script lang="ts">
import { defineAsyncComponent } from 'vue'

const CompanionChatImages = defineAsyncComponent(() => import('./CompanionChatImages.vue'))
const CompanionDrawingDraftCard = defineAsyncComponent(() => import('./CompanionDrawingDraftCard.vue'))
const CompanionDrawingBatchCard = defineAsyncComponent(() => import('./CompanionDrawingBatchCard.vue'))
</script>

<script setup lang="ts">
import type { ChatMessage } from '@/composables/chat/chatStorageTypes'

defineProps<{ message: ChatMessage }>()
</script>

<template>
  <CompanionDrawingBatchCard v-if="message.drawingBatchId" :key="message.drawingBatchId"
    :batch-id="message.drawingBatchId" :saved-images="message.images" />
  <CompanionChatImages v-else-if="message.images?.length" :images="message.images" />
  <CompanionDrawingDraftCard v-for="drawing in message.drawingDrafts || []" :key="drawing.path" :draft="drawing" />
</template>
