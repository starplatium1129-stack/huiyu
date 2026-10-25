<template>
  <img class="atelier-empty-art" :src="studioArt" width="768" height="512" alt="" aria-hidden="true" draggable="false" />
</template>

<script setup lang="ts">
import studioOriginal from '@/assets/illustrations/atelier-studio-768.webp'
import { useThemeIllustration } from '@/composables/useThemeIllustration'
const studioArt = useThemeIllustration(studioOriginal, 'draw')
</script>

<style scoped>
.atelier-empty-art { display:block; width:min(336px,100%); height:auto; margin:0 auto; pointer-events:none; }
</style>
