<template>
  <label class="companion-picker">
    <ArchiveIcon name="character" aria-hidden="true" />
    <select :value="modelValue" :aria-label="label" @change="$emit('update:modelValue', ($event.target as HTMLSelectElement).value)">
      <option v-for="character in characters" :key="character.id" :value="character.id">{{ character.name }}</option>
    </select>
  </label>
</template>

<script setup lang="ts">
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { listCompanionUiCharacters } from '@/utils/companionRegistry'
withDefaults(defineProps<{ modelValue: string; label?: string }>(), { label: '切换角色' })
defineEmits<{ 'update:modelValue': [id: string] }>()
const characters = listCompanionUiCharacters()
</script>

<style scoped>
.companion-picker { display: inline-flex; align-items: center; gap: var(--s-2); min-width: 0; color: var(--text-primary); }
.companion-picker > svg { flex: 0 0 18px; width: 18px; height: 18px; }
.companion-picker select { min-width: 0; width: 100%; max-width: 220px; min-height: 40px; padding: var(--s-2); border: 1px solid var(--border-soft); border-radius: var(--r-md); background: var(--bg-surface); color: var(--text-primary); font: inherit; cursor: pointer; }
</style>
