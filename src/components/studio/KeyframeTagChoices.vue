<template>
  <fieldset class="studio-guide-tags" :disabled="disabled">
    <legend>{{ label }}</legend>
    <div class="studio-guide-options">
      <button
        v-for="tag in visible"
        :key="tag.id"
        type="button"
        class="studio-guide-option"
        :aria-pressed="selected.includes(tag.id)"
        :disabled="selected.length >= limit && !selected.includes(tag.id)"
        data-spring-button
        @click="$emit('toggle', tag.id)"
      >
        <ArchiveIcon name="success" class="studio-guide-check" />
        <span>{{ tag.label }}</span>
      </button>
    </div>
    <button
      v-if="tags.length > 8"
      type="button"
      class="btn btn-ghost btn-sm"
      :aria-expanded="all"
      @click="all = !all"
    >
      {{ all ? '收起选项' : '展开全部' }}
    </button>
  </fieldset>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import type { KeyframeTag } from './h3TagCompiler'

const props = defineProps<{
  label: string
  tags: readonly KeyframeTag[]
  selected: readonly string[]
  limit: number
  disabled: boolean
}>()
defineEmits<{ toggle: [id: string] }>()
const all = ref(false)
const visible = computed(() => all.value ? props.tags : props.tags.filter((tag, index) => index < 8 || props.selected.includes(tag.id)))
</script>
