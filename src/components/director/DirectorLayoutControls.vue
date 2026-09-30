<template>
  <div class="director-layout-controls">
    <component v-if="menu" :is="menu" v-model:open="open" :collapsed="collapsed"
      @toggle="emit('toggle', $event)" @reset="emit('reset')" />
    <button v-else class="btn btn-ghost btn-sm" type="button" aria-label="工作台布局"
      aria-haspopup="dialog" :disabled="loading" @click="openMenu"><ArchiveIcon name="gear" />布局</button>
  </div>
</template>
<script setup lang="ts">
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { ref, shallowRef } from 'vue'
defineProps<{ collapsed: { materials: boolean; inspector: boolean } }>()
const emit = defineEmits<{ toggle: [side: 'materials' | 'inspector']; reset: [] }>()
const menu = shallowRef<typeof import('./DirectorLayoutMenu.vue')['default'] | null>(null)
const open = ref(false), loading = ref(false)
async function openMenu() {
  if (loading.value) return
  loading.value = true
  try {
    // Keep the trigger available until the first requested menu is loaded.
    menu.value = (await import('./DirectorLayoutMenu.vue')).default
    open.value = true
  } finally { loading.value = false }
}
</script>
<style scoped>
.director-layout-controls { display: none; }
@media (min-width: 1024px) {
  .director-layout-controls { display: block; }
}
</style>
