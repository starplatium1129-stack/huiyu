<template>
  <div v-if="issues.length" class="shot-review-list" aria-live="polite">
    <div
      v-for="(issue, issueIndex) in issues"
      :key="issueIndex"
      class="shot-review-item"
      :data-severity="issue.severity"
    >
      <span class="shot-review-tag">{{ issue.severity === 'error' ? '必须修' : '建议' }}</span>
      <span class="shot-review-copy">
        镜头 {{ issue.index + 1 }} · {{ issue.message }}
        <em v-if="issue.suggestion">→ {{ issue.suggestion }}</em>
      </span>
      <button
        v-if="issue.suggestion"
        class="btn btn-ghost btn-sm"
        type="button"
        :disabled="disabled"
        @click="emit('apply', issue)"
      >应用建议</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { VideoAiIssue } from '@/api/videoApi'

defineProps<{
  issues: VideoAiIssue[]
  disabled: boolean
}>()

const emit = defineEmits<{
  (event: 'apply', issue: VideoAiIssue): void
}>()
</script>

<style scoped src="@/assets/css/shot-review-issues.css"></style>
