<script setup lang="ts">
import { computed } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import { listCompanionUiCharacters } from '@/utils/companionRegistry'

const props = withDefaults(defineProps<{ modelValue: string; label?: string }>(), { label: '切换角色' })
const emit = defineEmits<{ 'update:modelValue': [id: string] }>()
const characters = listCompanionUiCharacters()
const currentCharacter = computed(() => characters.find(character => character.id === props.modelValue) || characters[0])
const options = characters.map(character => ({ value: character.id, label: character.name }))
const characterById = new Map(characters.map(character => [character.id, character]))
</script>

<template>
  <div class="companion-picker">
    <StudioSelect :model-value="modelValue" :options="options" :label="label"
      @update:model-value="emit('update:modelValue', String($event))">
      <template #value>
        <span v-content-motion:up="modelValue" class="companion-picker-value">
          <span class="companion-picker-mark" :data-character="modelValue" aria-hidden="true"><i /></span>
          <span class="companion-picker-copy"><strong>{{ currentCharacter?.name || '选择角色' }}</strong><small>当前陪伴</small></span>
        </span>
      </template>
      <template #header>
        <div class="companion-picker-heading" aria-hidden="true"><span><ArchiveIcon name="character" />陪伴角色</span><small>{{ characters.length }} 位可选</small></div>
      </template>
      <template #option="{ option }">
        <span class="companion-picker-value">
          <span class="companion-picker-mark" :data-character="String(option.value)" aria-hidden="true"><i /></span>
          <span class="companion-picker-copy"><strong>{{ option.label }}</strong><small>{{ option.value === modelValue ? '正在陪伴' : `切换到${characterById.get(String(option.value))?.shortName || option.label}` }}</small></span>
        </span>
      </template>
    </StudioSelect>
  </div>
</template>

<style>
.companion-picker { width:100%; min-width:0; max-width:220px; }
.companion-picker-value { display:flex; align-items:center; gap:var(--s-2); min-width:0; }
.companion-picker-mark { --companion-option-accent:var(--character-accent,var(--accent)); display:grid; place-items:center; flex:none; width:27px; height:27px; border:1px solid color-mix(in srgb,var(--companion-option-accent) 45%,var(--border-soft)); border-radius:50%; background:color-mix(in srgb,var(--companion-option-accent) 12%,var(--bg-surface)); }
.companion-picker-mark[data-character='nene'] { --companion-option-accent:var(--nene-violet); }
.companion-picker-mark[data-character='natsume'] { --companion-option-accent:var(--natsume-amber); }
.companion-picker-mark i { width:8px; height:8px; border-radius:50%; background:var(--companion-option-accent); }
.companion-picker-copy { display:flex; flex:1; flex-direction:column; min-width:0; }
.companion-picker-copy strong { overflow:hidden; color:var(--text-primary); font:600 var(--fs-label)/var(--lh-tight) var(--font-sans); text-overflow:ellipsis; white-space:nowrap; }
.companion-picker-copy small { overflow:hidden; color:var(--text-secondary); font:500 var(--fs-label-xs)/var(--lh-tight) var(--font-sans); text-overflow:ellipsis; white-space:nowrap; }
.companion-picker-heading { display:flex; align-items:center; justify-content:space-between; gap:var(--s-2); margin-bottom:var(--s-1); padding:var(--s-2) var(--s-3); border-bottom:1px solid var(--border-soft); color:var(--text-secondary); font-size:var(--fs-label-xs); }
.companion-picker-heading > span { display:inline-flex; align-items:center; gap:var(--s-2); }
.companion-picker-heading .archive-icon { width:16px; height:16px; }
@media (forced-colors:active) { .companion-picker-mark { border-color:CanvasText; background:Canvas; } .companion-picker-mark i { background:CanvasText; } }
</style>
