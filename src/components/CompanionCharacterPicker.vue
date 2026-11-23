<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue'
import ArchiveIcon from './visual/ArchiveIcon.vue'
import CompanionCharacterDialog from './CompanionCharacterDialog.vue'
import { getCompanionCharacter } from '@/utils/companionRegistry'
import { loadCompanionDirectory } from '@/router/companionResources'

const props = withDefaults(defineProps<{ modelValue: string; label?: string }>(), { label: '切换角色' })
const emit = defineEmits<{ 'update:modelValue': [id: string] }>()
const opener = shallowRef<HTMLButtonElement | null>(null)
const pending = ref(false), failed = ref(false)
const name = computed(() => getCompanionCharacter(props.modelValue)?.name || '选择角色')
async function readDirectory() {
  if (pending.value) return
  pending.value = true; failed.value = false
  try { await loadCompanionDirectory() }
  catch { failed.value = true }
  finally { pending.value = false }
}
function open(event: MouseEvent) {
  opener.value = event.currentTarget as HTMLButtonElement
  void readDirectory()
}
</script>

<template>
  <div class="companion-picker">
    <button class="companion-picker-trigger" type="button" aria-haspopup="dialog" :aria-expanded="!!opener"
      :aria-label="`${label}，当前${name}`" @click="open">
      <span class="companion-picker-copy"><strong>{{ name }}</strong><small>{{ label }}</small></span>
      <ArchiveIcon name="chevron-down" />
    </button>
    <CompanionCharacterDialog v-if="opener" :opener="opener" :selected-id="modelValue"
      @dismiss="opener = null" @select="emit('update:modelValue', $event)">
      <template #actions>
        <span v-if="pending" role="status" class="tw:text-secondary tw:text-label-sm">正在读取本地角色…</span>
        <button v-else-if="failed" type="button" class="btn btn-quiet btn-sm" @click="readDirectory">重试读取本地角色</button>
      </template>
    </CompanionCharacterDialog>
  </div>
</template>

<style>
.companion-picker { width:100%; min-width:0; max-width:220px; }
.companion-picker-trigger { display:flex; align-items:center; gap:var(--s-2); max-width:100%; min-height:var(--control-height-sm); padding:var(--s-1) var(--s-2); border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--bg-surface); color:var(--text-primary); font:inherit; text-align:left; cursor:pointer; }
.companion-picker-trigger:hover { background:var(--bg-hover); }
.companion-picker-trigger:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.companion-picker-trigger > .archive-icon { flex:none; width:16px; height:16px; color:var(--text-secondary); }
.companion-picker-copy { display:grid; min-width:0; }
.companion-picker-copy strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font:600 var(--fs-label)/var(--lh-label) var(--font-sans); }
.companion-picker-copy small { color:var(--text-secondary); font-size:var(--fs-label-xs); }
</style>
