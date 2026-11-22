<script setup lang="ts">
import RuntimeImage from './visual/RuntimeImage.vue'
import type { CharacterConfig } from '@/config/characters'
defineProps<{ character: CharacterConfig }>()
defineEmits<{ load: []; error: [] }>()
</script>

<template>
  <aside class="character-card card-portrait" :aria-label="character.name">
    <RuntimeImage :src="character.image" :alt="character.name" @load="$emit('load')" @error="$emit('error')" />
    <div class="character-info"><strong class="character-name">{{ character.name }}</strong></div>
  </aside>
</template>

<style scoped>
.card-portrait { display: grid; grid-template-rows: minmax(0, 1fr) auto; min-height: 0; }
.card-portrait img { width: 100%; height: 100%; min-height: 0; object-fit: contain; }
</style>
