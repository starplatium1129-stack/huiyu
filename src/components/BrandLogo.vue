<template>
  <img :crossorigin="runtimeResourceCors()" :src="resolveRuntimeUrl(theme === 'light' ? '/assets/logo-light.svg' : '/assets/logo.svg')" width="132" height="48" decoding="sync" alt="绘遇 · HUIYU" />
</template>

<script setup lang="ts">
import { resolveRuntimeUrl, runtimeResourceCors } from '@/platform/runtimeUrl'

import { useTheme } from '@/composables/useTheme'

const { theme } = useTheme()
</script>
