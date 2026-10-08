<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PromptDataTools from '@/components/PromptDataTools.vue'
import { useToast } from '@/composables/useToast'

const route = useRoute(), router = useRouter()
const { show } = useToast()
const open = computed({
  get: () => route.path === '/gallery' && route.query.panel === 'backup',
  set: value => {
    // KeepAlive closes the popover after navigation; it must not replace the destination route.
    if (route.path === '/gallery') void router.replace({ query: { ...route.query, panel: value ? 'backup' : undefined } })
  },
})
</script>

<template>
  <PromptDataTools v-model:open="open" launcher-label="数据与备份" @flash="show($event)" />
</template>
