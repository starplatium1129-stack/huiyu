<template><component :is="privateResult ? 'button' : 'a'" :href="privateResult ? undefined : resolveRuntimeUrl(src)" :download="privateResult ? undefined : filename" :type="privateResult ? 'button' : undefined" :disabled="busy" @click="download"><slot />{{ busy ? ' · 下载中…' : '' }}<span v-if="error" role="status"> · {{ error }}</span></component></template>
<script setup lang="ts">
import { computed, ref } from 'vue'
import { isRuntimeResultPath, downloadTaskMedia } from '@/api/runtimeTasks'
import { resolveRuntimeUrl } from '@/platform/runtimeUrl'
const props = withDefaults(defineProps<{ src: string; filename?: string }>(), { filename: '绘遇作品.mp4' })
const privateResult = computed(() => isRuntimeResultPath(props.src)), busy = ref(false), error = ref('')
async function download() { if (!privateResult.value || busy.value) return; busy.value = true; error.value = ''; try { await downloadTaskMedia(props.src, props.filename) } catch { error.value = '下载未完成，可重新读取' } finally { busy.value = false } }
</script>
