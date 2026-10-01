<template><span class="character-portrait tw:grid tw:place-items-center tw:w-[48px] tw:h-[60px] tw:flex-none tw:overflow-hidden tw:rounded-md" :data-state="failed || pending || !image.src ? 'placeholder' : 'image'" aria-hidden="true"><img v-if="image.src && !failed && !pending" v-bind="image" class="tw:block tw:w-full tw:h-full tw:object-cover" alt="" loading="lazy" decoding="async" /><span v-else class="portrait-initial tw:text-secondary tw:text-body-lg tw:font-semibold">{{ name.slice(0, 1) || '人' }}</span></span></template>
<script setup lang="ts">
import { useRuntimeImage } from '@/composables/useRuntimeImage'

import { computed } from 'vue'
const props = defineProps<{ src?: string; name: string }>()
const { image, failed } = useRuntimeImage(() => props.src)
const pending = computed(() => !props.src || props.src.includes('portrait-pending'))
</script>
<style scoped>
.character-portrait { border: 1px solid var(--border-soft); background: var(--bg-elevated); }
.character-portrait img { object-position: center 20%; }
</style>
