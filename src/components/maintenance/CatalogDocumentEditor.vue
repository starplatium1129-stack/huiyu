<template>
  <div>
    <template v-if="record.id === 'tags' && Array.isArray(record.data)">
      <input v-model="query" class="input" type="search" aria-label="搜索标签" placeholder="搜索标签…" />
      <p class="hint-sm">修改名称或删除用词时，相关故事也会一起更新。保存前可以核对这些变化。</p>
      <div v-for="tag in pagedTags" :key="String(tag.id)" class="form-grid catalog-tag-row">
        <label v-for="field in tagFields" :key="field[0]" class="form-group"><span class="field-label">{{ field[1] }}</span><input v-model="tag[field[0]]" class="input" :disabled="disabled" /></label>
        <label class="form-group"><span class="field-label">权重</span><input v-model.number="tag.weight" class="input" type="number" min="0.01" max="2" step="0.1" :disabled="disabled" /></label>
        <button class="btn btn-danger btn-sm" type="button" :disabled="disabled" @click="tagRows.splice(tagRows.indexOf(tag), 1)">删除标签</button>
      </div>
      <button class="btn btn-ghost" type="button" :disabled="disabled" @click="addTag">新增标签</button>
      <div class="catalog-actions"><button class="btn btn-ghost btn-sm" type="button" :disabled="page <= 1" @click="page--">上一页</button><span>{{ page }} / {{ pages }}</span><button class="btn btn-ghost btn-sm" type="button" :disabled="page >= pages" @click="page++">下一页</button></div>
    </template>
    <template v-else-if="record.id === 'curation'">
      <label v-for="field in curationFields" :key="field[0]" class="form-group catalog-curation-field"><span class="field-label">{{ field[1] }}</span><textarea class="input" rows="5" :value="list(field[0])" :disabled="disabled" @change="setList(field[0], ($event.target as HTMLTextAreaElement).value)"></textarea><span class="hint-sm">每行填写一份故事的编号，顺序就是展示次序</span></label>
    </template>
    <p v-else-if="record.id === 'tag-dictionary-policy'" class="hint-sm">重复词与别名的归属在高级字段中维护，可与用词修改一起预览和保存。新冲突需要明确选择归属。</p>
    <p v-else class="hint-sm">这份资料由专门流程维护，可以在这里查看。</p>
  </div>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { CatalogRecord } from '@/api/catalogApi'
defineProps<{ disabled: boolean }>()
const record = defineModel<CatalogRecord>('record', { required: true })
const tagRows = computed(() => Array.isArray(record.value.data) ? record.value.data as Array<Record<string, string | number>> : [])
const query = ref(''), page = ref(1)
const filtered = computed(() => tagRows.value.filter(t => [t.id, t.en, t.cn, t.cat].join(' ').toLowerCase().includes(query.value.trim().toLowerCase())))
const pages = computed(() => Math.max(1, Math.ceil(filtered.value.length / 24)))
const pagedTags = computed(() => filtered.value.slice((page.value - 1) * 24, page.value * 24))
watch(query, () => { page.value = 1 })
watch(pages, total => { page.value = Math.min(page.value, total) })
const tagFields = [['en', '绘制关键词'], ['cn', '显示名称'], ['cat', '分类']] as const
function addTag() {
  const maximum = Math.max(0, ...tagRows.value.map(t => Number(String(t.id).replace(/^tag_/, '')) || 0))
  tagRows.value.push({ id: 'tag_' + String(maximum + 1).padStart(3, '0'), en: '', cn: '', cat: 'Scene', weight: 1 })
  query.value = ''; page.value = pages.value
}
const curationFields = [['personaCoreSceneIds', '人物核心场景'], ['signatureSceneIds', '招牌场景'], ['curatedSceneIds', '精选场景'], ['reviewSceneIds', '待审核场景']] as const
const list = (key: string) => ((record.value.data as Record<string, unknown>)[key] as string[] | undefined)?.join('\n') ?? ''
function setList(key: string, input: string) { (record.value.data as Record<string, unknown>)[key] = input.split('\n').map(s => s.trim()).filter(Boolean) }
</script>
