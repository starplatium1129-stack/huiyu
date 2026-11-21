<script setup lang="ts">
import { computed } from 'vue'
import '@/assets/css/components/studio-skeleton.css'

const props = withDefaults(defineProps<{
  variant?: 'card' | 'line' | 'media'
  width?: string
  height?: string
  aspectRatio?: string
  lines?: number
  animated?: boolean
  label?: string
}>(), {
  variant: 'line',
  width: '',
  height: '',
  aspectRatio: '',
  lines: 1,
  animated: true,
  label: '',
})

const boxStyle = computed(() => {
  const style: Record<string, string> = {}
  if (props.width) style.width = props.width
  if (props.height) style.height = props.height
  if (props.aspectRatio) style.aspectRatio = props.aspectRatio
  return style
})

const lineCount = computed(() => Math.max(1, Math.floor(props.lines)))
</script>

<template>
  <div
    v-if="variant === 'line' && lineCount > 1"
    class="studio-skeleton-lines"
    :role="label ? 'status' : undefined"
    :aria-busy="label ? 'true' : undefined"
    :aria-hidden="label ? undefined : 'true'"
  >
    <span v-if="label" class="sr-only">{{ label }}</span>
    <span
      v-for="n in lineCount"
      :key="n"
      class="studio-skeleton"
      data-variant="line"
      :data-animated="animated"
      :style="{
        width: n === lineCount ? (width || '72%') : (width || '100%'),
        height: height || undefined,
      }"
      aria-hidden="true"
    />
  </div>
  <div
    v-else
    class="studio-skeleton"
    :data-variant="variant"
    :data-animated="animated"
    :style="boxStyle"
    :role="label ? 'status' : undefined"
    :aria-busy="label ? 'true' : undefined"
    :aria-hidden="label ? undefined : 'true'"
  >
    <span v-if="label" class="sr-only">{{ label }}</span>
    <slot v-if="variant === 'card'">
      <span class="studio-skeleton-card-media" aria-hidden="true" />
      <span class="studio-skeleton-card-lines" aria-hidden="true">
        <span class="studio-skeleton-bar" />
        <span class="studio-skeleton-bar is-short" />
      </span>
    </slot>
  </div>
</template>
