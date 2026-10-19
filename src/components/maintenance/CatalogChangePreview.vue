<template>
  <section v-content-motion:up="preview" class="catalog-change-preview" aria-label="修改预览">
    <header><h2>修改预览</h2></header>
    <details v-for="diff in diffs" :key="diff.kind + ':' + diff.id" open>
      <StudioDisclosureSummary>{{ diff.after ? recordTitle(diff.after) : diff.before ? recordTitle(diff.before) : '待整理的内容' }} <small>{{ !diff.before ? '新加入' : !diff.after ? '将归档' : '已编辑' }}</small></StudioDisclosureSummary>
      <div data-disclosure-content>
        <div v-for="field in diff.fields" :key="field.path" class="catalog-change-row">
          <strong>{{ field.label }}</strong><div><span>原来</span><p>{{ field.before || '尚未填写' }}</p></div><div><span>现在</span><p>{{ field.after || '尚未填写' }}</p></div>
        </div>
        <p v-if="diff.before && diff.after && diff.before.sortOrder !== diff.after.sortOrder" class="catalog-note">展示位置已调整。</p>
        <details class="catalog-advanced" @toggle="($event.target as HTMLDetailsElement).open && revealedDiffs.add(diff.kind + ':' + diff.id)"><StudioDisclosureSummary>查看完整变化</StudioDisclosureSummary><div data-disclosure-content class="catalog-diff"><template v-if="revealedDiffs.has(diff.kind + ':' + diff.id)"><pre>{{ JSON.stringify(diff.before?.data ?? null, null, 2) }}</pre><pre>{{ JSON.stringify(diff.after?.data ?? null, null, 2) }}</pre></template></div></details>
      </div>
    </details>
    <details v-for="record in preview.retiredImports ?? []" :key="record.kind + ':' + record.id" open>
      <StudioDisclosureSummary>{{ recordTitle(record) }} <small>登记归档身份</small></StudioDisclosureSummary>
      <div data-disclosure-content>
        <p class="catalog-note">{{ CATALOG_LABELS[record.kind] }} · <code>{{ record.id }}</code></p>
        <p class="catalog-note">保留归档身份，后续新增内容将继续避开该编号。</p>
      </div>
    </details>
  </section>
</template>
<script setup lang="ts">
import { computed, reactive } from 'vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import type { CatalogReceipt, CatalogRecord } from '@/api/catalogApi'
import { CATALOG_FIELDS, fieldValue } from '@/composables/scene/catalogFields'
import { CATALOG_LABELS, recordTitle } from '@/composables/scene/catalogPresentation'
const props = defineProps<{ preview: CatalogReceipt }>()
const revealedDiffs = reactive(new Set<string>())
const diffs = computed(() => props.preview.diffs.map(diff => ({ ...diff, fields: changedFields(diff.before, diff.after) })))
function changedFields(before: CatalogRecord | null, after: CatalogRecord | null) {
  const kind = (after || before)!.kind
  return CATALOG_FIELDS[kind].map(field => {
    const old = before ? fieldValue(before.data, field.path) : undefined, next = after ? fieldValue(after.data, field.path) : undefined
    const display = (v: unknown) => v === true ? '是' : v === false ? '否' : Array.isArray(v) ? v.join('、') : v && typeof v === 'object' ? JSON.stringify(v) : String(v ?? '')
    return { path: field.path, label: field.label, before: display(old), after: display(next), changed: JSON.stringify(old) !== JSON.stringify(next) }
  }).filter(field => field.changed)
}
</script>
