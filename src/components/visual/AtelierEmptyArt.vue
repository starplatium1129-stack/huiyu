<template>
  <img class="atelier-empty-art" :src="studioArt" width="1536" height="1024" alt="" aria-hidden="true" draggable="false" />
</template>

<script setup lang="ts">
import studioArt from '@/assets/illustrations/atelier-studio.png'
</script>

<style scoped>
.atelier-empty-art { display:block; width:min(336px,100%); height:auto; margin:0 auto; pointer-events:none; }
</style>
