<template>
  <input v-model="draft" class="input" />
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'

const keywords = defineModel<string[]>({ required: true })
const raw = ref(keywords.value.join(', '))
const parse = (value: string) => value.split(/[,，]/).map(item => item.trim()).filter(Boolean)

const draft = computed({
  get: () => raw.value,
  set: (value: string) => {
    raw.value = value
    keywords.value = parse(value)
  },
})

watch(keywords, next => {
  const current = parse(raw.value)
  if (current.length !== next.length || next.some((key, index) => key !== current[index])) raw.value = next.join(', ')
})
</script>
