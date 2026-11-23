<script setup lang="ts">
import StudioIllustratedCard from '@/components/ui/StudioIllustratedCard.vue'
import { useThemeIllustration } from '@/composables/useThemeIllustration'
import inspiration from '@/assets/illustrations/atelier-inspiration-spot-256.webp'
import drawing from '@/assets/illustrations/atelier-create-spot-256.webp'
import collection from '@/assets/illustrations/atelier-collection-spot-256.webp'

defineEmits<{ navigate: [] }>()
const steps = [
  { to: '/scene-explorer', title: '挑选场景', art: useThemeIllustration(inspiration, 'scene') },
  { to: '/prompt-builder', title: '进入绘制台', art: useThemeIllustration(drawing, 'draw') },
  { to: '/gallery', title: '我的作品', art: useThemeIllustration(collection, 'collection') },
]
</script>

<template>
  <ol class="guide-steps" role="list">
    <li v-for="step in steps" :key="step.to">
      <StudioIllustratedCard :to="step.to" :title="step.title" compact @click="$emit('navigate')">
        <template #art>
          <img :src="step.art.value" class="step-art" width="256" height="256" alt="" loading="lazy" decoding="async" draggable="false" />
        </template>
      </StudioIllustratedCard>
    </li>
  </ol>
</template>

<style scoped>
.guide-steps {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--s-3);
  margin: 0;
  padding: 0;
  list-style: none;
}
.guide-steps li { display: grid; min-width: 0; }
.guide-steps li:nth-child(2) { --destination-tint: var(--nene-violet); }
.guide-steps li:nth-child(3) { --destination-tint: var(--natsume-amber); }
@media (max-width: 560px) {
  .guide-steps { grid-template-columns: minmax(0, 1fr); gap: var(--s-2); }
}
</style>
