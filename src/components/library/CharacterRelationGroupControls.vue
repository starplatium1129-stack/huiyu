<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { RelationPerson } from '@/types/characterRelations'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioPopover from '@/components/ui/StudioPopover.vue'
import StudioSearch from '@/components/ui/StudioSearch.vue'

const props = defineProps<{ group: string; members: RelationPerson[]; page: number; pageSize: number; pageCount: number }>()
const emit = defineEmits<{ page: [value: number]; locate: [id: string] }>()
const open = ref(false), query = ref(''), locating = ref(false)
const matches = computed(() => {
  const value = query.value.trim().toLocaleLowerCase()
  return props.members.filter(person => !value || [person.name, ...person.aliases].some(name => name.toLocaleLowerCase().includes(value)))
})
function locate(id: string) { locating.value = true; open.value = false; emit('locate', id) }
watch(() => props.group, () => { open.value = false; query.value = '' })
</script>

<template>
  <div class="atlas-group-controls" role="group" :aria-label="`${group}人物浏览`">
    <span v-if="pageCount > 1" class="atlas-page-range" role="status">{{ page * pageSize + 1 }}–{{ Math.min((page + 1) * pageSize, members.length) }} / {{ members.length }} 人</span>
    <template v-if="pageCount > 1">
      <button class="btn btn-ghost btn-sm btn-icon" type="button" aria-label="上一页人物" :disabled="page === 0" @click="emit('page', page - 1)"><ArchiveIcon class="atlas-previous" name="chevron-down" /></button>
      <span class="atlas-page-number">{{ page + 1 }} / {{ pageCount }}</span>
      <button class="btn btn-ghost btn-sm btn-icon" type="button" aria-label="下一页人物" :disabled="page + 1 >= pageCount" @click="emit('page', page + 1)"><ArchiveIcon class="atlas-next" name="chevron-down" /></button>
    </template>
    <StudioPopover v-model:open="open" label="本区人物名录" align="start" @close-auto-focus="event => { if (locating) { event.preventDefault(); locating = false } }">
      <template #trigger><button class="btn btn-ghost btn-sm" type="button"><ArchiveIcon name="character" />本区名录</button></template>
      <div class="atlas-roster">
        <strong>{{ group }} · {{ members.length }} 位人物</strong>
        <StudioSearch v-model="query" label="搜索本区人物" placeholder="姓名或别名" size="sm" />
        <div class="atlas-roster-list">
          <button v-for="person in matches" :key="person.id" class="btn btn-ghost btn-sm" type="button" @click="locate(person.id)"><span>{{ person.name }}</span><span>定位<ArchiveIcon name="search" /></span></button>
          <p v-if="!matches.length" role="status">未找到人物，请换个姓名或别名。</p>
        </div>
      </div>
    </StudioPopover>
  </div>
</template>

<style scoped>
.atlas-group-controls { display: flex; align-items: center; flex-wrap: wrap; gap: var(--s-1); padding: var(--s-1) var(--s-2); border: 1px solid var(--border-soft); border-radius: var(--r-md); background: var(--bg-surface); box-shadow: var(--shadow-sm); }
.atlas-page-range { margin-inline: var(--s-2); color: var(--text-secondary); font-size: var(--fs-label-sm); font-variant-numeric: tabular-nums; }
.atlas-page-number { min-width: 42px; text-align: center; font-size: var(--fs-label-sm); font-variant-numeric: tabular-nums; }
.atlas-previous { transform: rotate(90deg); }
.atlas-next { transform: rotate(-90deg); }
.atlas-roster { display: grid; gap: var(--s-3); }
.atlas-roster > strong { font-size: var(--fs-label); }
.atlas-roster-list { display: grid; gap: var(--s-1); max-height: 320px; overflow-y: auto; }
.atlas-roster-list button { justify-content: space-between; min-height: 40px; }
.atlas-roster-list button > span:last-child { display: flex; align-items: center; gap: var(--s-2); color: var(--text-secondary); font-size: var(--fs-label-sm); }
.atlas-roster-list p { color: var(--text-secondary); font-size: var(--fs-label); }
</style>
