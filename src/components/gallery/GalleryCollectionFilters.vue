<template>
  <div class="collection-filters" role="group" aria-label="作品角色与标签筛选">
    <label class="collection-field"><span>角色</span><StudioSelect v-model="character" label="按角色筛选" :options="characterOptions" /></label>
    <label v-if="tags.length" class="collection-field"><span>标签</span><StudioSelect v-model="tag" label="按标签筛选" :options="[{value:'',label:'全部标签'}, ...tags]" /></label>
    <button class="btn btn-quiet btn-sm collection-save" type="button" :disabled="disabled" @click="smartRule ? emit('edit') : emit('save')"><ArchiveIcon :name="smartRule ? 'book' : 'pin'" />{{ smartRule ? '编辑智能画册' : '保存为智能画册' }}</button>
    <p v-if="smartRule" class="collection-rule"><ArchiveIcon name="refresh" /><span>{{ smartAlbumSummary(smartRule, characterName) }} · 自动更新</span></p>
  </div>
</template>
<script setup lang="ts">
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { computed } from 'vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import type { SmartAlbumRule } from '@/application/artwork/smartAlbums'
import { smartAlbumSummary } from '@/composables/gallery/galleryAlbumRules'
const props = defineProps<{ characters: { value: string; label: string }[]; tags: { value: string; label: string }[]; smartRule?: SmartAlbumRule; characterName: (id: string) => string; disabled: boolean }>()
const emit = defineEmits<{ save: []; edit: [] }>()
const character = defineModel<string>('character', { required: true })
const tag = defineModel<string>('tag', { required: true })
const characterOptions = computed(() => [{value:'',label:'全部角色'}, ...props.characters,
  ...(character.value && !props.characters.some(item => item.value === character.value) ? [{value:character.value,label:`${props.characterName(character.value)} · 0`}] : [])])
</script>
<style scoped>
@reference "../../assets/css/tailwind.css";
.collection-filters { @apply tw:flex tw:items-end tw:flex-wrap tw:gap-s-3; }
.collection-field { display:grid; gap:var(--s-1); flex:1 1 180px; min-width:0; color:var(--text-secondary); font-size:var(--fs-label-sm); }
.collection-save { margin-left:auto; min-height:var(--control-height); }
.collection-rule { @apply tw:flex tw:items-center tw:gap-s-2 tw:m-0 tw:text-secondary tw:text-label-sm tw:leading-body; width:100%; overflow-wrap:anywhere; }
.collection-rule .archive-icon { @apply tw:w-[16px] tw:h-[16px] tw:shrink-0; }
.collection-filters button { max-width:100%; white-space:normal; overflow-wrap:anywhere; }
</style>
