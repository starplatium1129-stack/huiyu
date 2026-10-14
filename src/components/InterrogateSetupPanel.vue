<template>
  <section class="panel-card interrogate-setup" aria-labelledby="interrogate-setup-title">
    <h2 id="interrogate-setup-title" class="panel-heading">图片反推</h2>
    <p role="status" aria-live="polite">{{ readiness.status.value.message }}</p>
    <button class="btn btn-ghost btn-sm" type="button" :disabled="readiness.checking.value" @click="readiness.refresh()">{{ readiness.checking.value ? '检查中…' : '重新检查' }}</button>
  </section>
</template>
<script setup lang="ts">
import { onMounted } from 'vue'
import { useInterrogateReadiness } from '@/composables/useInterrogateReadiness'
const readiness = useInterrogateReadiness()
onMounted(() => { void readiness.refresh() })
</script>
<style scoped>
.interrogate-setup { margin-bottom: var(--s-5); color: var(--text-primary); }
.interrogate-setup p { color: var(--text-secondary); line-height: var(--lh-loose); overflow-wrap: anywhere; }
.interrogate-setup button:focus-visible { outline: none; box-shadow: var(--focus-shadow); }
.interrogate-setup button:disabled { color: var(--text-disabled); opacity: 1; }
</style>
