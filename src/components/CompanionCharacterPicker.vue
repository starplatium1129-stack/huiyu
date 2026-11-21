<script setup lang="ts">
import { computed, shallowRef } from 'vue'
import ArchiveIcon from './visual/ArchiveIcon.vue'
import CompanionCharacterDialog from './CompanionCharacterDialog.vue'
import { getCompanionCharacter } from '@/utils/companionRegistry'

const props = withDefaults(defineProps<{ modelValue: string; label?: string }>(), { label: '切换角色' })
const emit = defineEmits<{ 'update:modelValue': [id: string] }>()
const opener = shallowRef<HTMLButtonElement | null>(null)
const name = computed(() => getCompanionCharacter(props.modelValue)?.name || '选择角色')
</script>

<template>
  <div class="companion-picker">
    <button class="companion-picker-trigger" type="button" aria-haspopup="dialog" :aria-expanded="!!opener"
      :aria-label="`${label}，当前${name}`" @click="opener = $event.currentTarget as HTMLButtonElement">
      <span class="companion-picker-copy"><strong>{{ name }}</strong><small>{{ label }}</small></span>
      <ArchiveIcon name="chevron-down" />
    </button>
    <CompanionCharacterDialog v-if="opener" :opener="opener" :selected-id="modelValue"
      @dismiss="opener = null" @select="emit('update:modelValue', $event)" />
  </div>
</template>

<style>
.companion-picker { width:100%; min-width:0; max-width:220px; }
.companion-picker-trigger { display:flex; align-items:center; gap:var(--s-2); max-width:100%; min-height:var(--control-height-sm); padding:var(--s-1) var(--s-2); border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--bg-surface); color:var(--text-primary); font:inherit; text-align:left; cursor:pointer; }
.companion-picker-trigger:hover { background:var(--bg-hover); }
.companion-picker-trigger:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
.companion-picker-trigger > .archive-icon { flex:none; width:16px; height:16px; color:var(--text-secondary); }
.companion-picker-copy { display:grid; min-width:0; }
.companion-picker-copy strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font:600 var(--fs-label)/var(--lh-label) var(--font-sans); }
.companion-picker-copy small { color:var(--text-secondary); font-size:var(--fs-label-xs); }
</style>
