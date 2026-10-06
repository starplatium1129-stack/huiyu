<template>
  <section v-content-motion:up="preview" class="catalog-change-preview" aria-label="修改预览">
    <header><h2>这次改了什么</h2><p>核对好这些变化，再保存或导入。</p></header>
    <details v-for="diff in preview.diffs" :key="diff.kind + ':' + diff.id" open>
      <summary>{{ diff.after ? recordTitle(diff.after) : diff.before ? recordTitle(diff.before) : '待整理的内容' }} <small>{{ !diff.before ? '新加入' : !diff.after ? '将归档' : '已编辑' }}</small></summary>
      <div v-for="field in changedFields(diff.before, diff.after)" :key="field.path" class="catalog-change-row">
        <strong>{{ field.label }}</strong><div><span>原来</span><p>{{ field.before || '尚未填写' }}</p></div><div><span>现在</span><p>{{ field.after || '尚未填写' }}</p></div>
      </div>
      <p v-if="diff.before && diff.after && diff.before.sortOrder !== diff.after.sortOrder" class="catalog-note">展示位置已调整。</p>
      <details class="catalog-advanced"><summary>查看完整变化</summary><div data-disclosure-content class="catalog-diff"><pre>{{ JSON.stringify(diff.before?.data ?? null, null, 2) }}</pre><pre>{{ JSON.stringify(diff.after?.data ?? null, null, 2) }}</pre></div></details>
    </details>
  </section>
</template>
<script setup lang="ts">
import type { CatalogReceipt, CatalogRecord } from '@/api/catalogApi'
import { CATALOG_FIELDS, fieldValue } from '@/composables/scene/catalogFields'
import { recordTitle } from '@/composables/scene/catalogPresentation'
defineProps<{ preview: CatalogReceipt }>()
function changedFields(before: CatalogRecord | null, after: CatalogRecord | null) {
  const kind = (after || before)!.kind
  return CATALOG_FIELDS[kind].map(field => {
    const old = before ? fieldValue(before.data, field.path) : undefined, next = after ? fieldValue(after.data, field.path) : undefined
    const display = (v: unknown) => v === true ? '是' : v === false ? '否' : Array.isArray(v) ? v.join('、') : v && typeof v === 'object' ? JSON.stringify(v) : String(v ?? '')
    return { path: field.path, label: field.label, before: display(old), after: display(next), changed: JSON.stringify(old) !== JSON.stringify(next) }
  }).filter(field => field.changed)
}
</script>
