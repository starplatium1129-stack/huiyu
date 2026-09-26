<template><span class="character-portrait" :data-state="failed || pending ? 'placeholder' : 'image'" aria-hidden="true"><img :crossorigin="runtimeResourceCors()" v-if="src && !failed && !pending" :src="resolveRuntimeUrl(src)" alt="" loading="lazy" decoding="async" @error="failed = true" /><span v-else class="portrait-initial">{{ name.slice(0, 1) || '人' }}</span></span></template>
<script setup lang="ts">
import { resolveRuntimeUrl, runtimeResourceCors } from '@/platform/runtimeUrl'

import { computed, ref, watch } from 'vue'
const props = defineProps<{ src?: string; name: string }>()
const failed = ref(false)
const pending = computed(() => !props.src || props.src.includes('portrait-pending'))
watch(() => props.src, () => { failed.value = false })
</script>
<style scoped>
.character-portrait { display: grid; place-items: center; width: 48px; height: 60px; flex: 0 0 auto; overflow: hidden; border: 1px solid var(--border-soft); border-radius: var(--r-md); background: var(--bg-elevated); }
.character-portrait img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: center 20%; transform: scale(1.2); transform-origin: center 20%; }
.portrait-initial { color: var(--text-secondary); font-size: var(--fs-body-lg); font-weight: 600; }
</style>
