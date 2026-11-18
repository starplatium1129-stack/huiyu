<template>
  <header class="creative-library-header">
    <div class="creative-library-heading" data-route-arrive>
      <img class="creative-library-mark" :src="current.art.value" alt="" width="96" height="96" decoding="async" draggable="false" />
      <div>
        <p class="creative-library-kicker">创作手帖</p>
        <h1>{{ current.title }}</h1>
        <p class="creative-library-description">{{ current.description }}</p>
      </div>
    </div>
    <nav class="creative-library-nav studio-segments" role="navigation" data-fluid-glass aria-label="创作资料导航">
      <AnimatedSelection target="[aria-current='page']" />
      <RouterLink v-for="(item, id) in chapters" :key="id" :to="'/' + id">
        <ArchiveIcon :name="item.icon" /><span>{{ item.label }}</span>
      </RouterLink>
    </nav>
  </header>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import { useThemeIllustration } from '@/composables/useThemeIllustration'
import inspiration from '@/assets/illustrations/atelier-inspiration-spot.webp'
import palette from '@/assets/illustrations/atelier-palette-spot.webp'
import model from '@/assets/illustrations/atelier-model-spot.webp'
import collection from '@/assets/illustrations/atelier-collection-spot.webp'

const props = defineProps<{ chapter: 'style' | 'color-script' | 'lora' | 'scenario' }>()
const chapters = {
  style: { title:'画风', label:'画风与氛围', description:'色彩情绪与氛围调子', icon:'image', art:useThemeIllustration(inspiration, 'scene') },
  'color-script': { title:'色彩情绪', label:'色彩情绪', description:'光照与调色预设', icon:'palette', art:useThemeIllustration(palette, 'palette') },
  lora: { title:'模型资料', label:'模型资料', description:'角色 LoRA 与画风模型库', icon:'model', art:useThemeIllustration(model, 'model') },
  scenario: { title:'剧本模式', label:'剧本与分幕', description:'分幕故事与连贯场景', icon:'book', art:useThemeIllustration(collection, 'collection') },
} as const
const current = computed(() => chapters[props.chapter])
</script>

<style src="@/assets/css/creative-library.css"></style>
