<template>
  <section class="scene-impact tw:mb-s-4 tw:p-s-4 tw:rounded-lg tw:text-primary tw:text-body-sm tw:leading-loose" aria-labelledby="scene-impact-title" :aria-busy="busy" data-testid="scene-impact">
    <header>
      <div>
        <h2 id="scene-impact-title">保存影响预览</h2>
        <p>仅预览已保存到草稿的修改。预览不会写入项目，也不代表真实画面或设备验收。</p>
      </div>
      <button class="btn btn-ghost" type="button" :disabled="!enabled" @click="$emit('preview')">
        <ArchiveIcon name="eye" />{{ busy ? '正在预览…' : '刷新影响预览' }}
      </button>
    </header>
    <p v-if="error" class="impact-error" role="alert">{{ error }}</p>
    <p role="status" aria-live="polite">
      {{ busy ? '正在读取当前草稿的影响范围…' : invalidated ? '草稿或读取基线已变化，旧预览已失效，请刷新。' : empty ? '没有需要保存的变更。' : preview ? `当前草稿预览 · 读取版本 ${preview.baseVersion}` : '尚未预览。点击“刷新影响预览”查看新增、修改、退役和相关引用。' }}
    </p>
    <div v-if="preview && !busy && !invalidated" data-testid="scene-impact-result">
      <div class="impact-groups tw:grid tw:gap-s-3">
        <details v-for="group in groups" :key="group.key" :open="group.items.length > 0 && group.items.length <= 5" :data-impact="group.key">
          <summary>{{ group.label }} · {{ group.items.length }}</summary>
          <ul v-if="group.items.length" tabindex="0" :aria-label="group.label" class="impact-list tw:max-h-[240px] tw:overflow-auto">
            <li v-for="item in group.items" :key="item.id"><code>{{ item.id }}</code><span>{{ item.title }}</span></li>
          </ul>
          <p v-else>无变更</p>
        </details>
      </div>
      <p v-if="companions.length">{{ companions.join('；') }}。保存时一同提交。</p>
      <h3>相关引用 · {{ preview.related.length }}</h3>
      <ul v-if="preview.related.length" class="impact-list tw:max-h-[240px] tw:overflow-auto" tabindex="0" aria-label="相关引用">
        <li v-for="(item, index) in preview.related" :key="`${item.kind}-${item.id}-${index}`"><code>{{ item.id }}</code><span>{{ item.reason }}</span></li>
      </ul>
      <p v-else>预览未发现相关引用。</p>
      <h3>检查范围</h3>
      <p>以下包含实际保存时执行的检查，并非全部已通过。</p>
      <ul><li v-for="(check, index) in preview.checks" :key="index">{{ check }}</li></ul>
      <h3>未知或未验证范围</h3>
      <ul v-if="preview.unknown.length" class="impact-unknown tw:text-warning-text"><li v-for="(item, index) in preview.unknown" :key="index">{{ item }}</li></ul>
      <p v-else>服务端未声明额外未知项；本预览仍不替代实际画面与设备验收。</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import type { SceneChangesPreview } from '@/types/api'
defineProps<{
  preview: SceneChangesPreview | null
  groups: Array<{ key: string; label: string; items: Array<{ id: string; title: string }> }>
  companions: string[]
  busy: boolean
  enabled: boolean
  error: string
  invalidated: boolean
  empty: boolean
}>()
defineEmits<{ preview: [] }>()
</script>

<style scoped>
@reference "../../assets/css/tailwind.css";
.scene-impact { border: 1px solid var(--border-soft); background: var(--bg-surface); overflow-wrap: anywhere; }
.scene-impact header { @apply tw:flex tw:flex-wrap; align-items: start; @apply tw:justify-between tw:gap-s-3; }
.scene-impact header > div { flex: 1 1 260px; @apply tw:min-w-0; }
.scene-impact h2 { @apply tw:m-0 tw:text-title-sm; }
.scene-impact h3 { margin: var(--s-4) 0 var(--s-2); @apply tw:text-body; }
.scene-impact p { margin: var(--s-2) 0; @apply tw:text-secondary; }
.scene-impact .impact-error { @apply tw:text-danger-text; }
.impact-groups { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.impact-groups details { @apply tw:min-w-0 tw:p-s-3; border: 1px solid var(--border-soft); @apply tw:rounded-md; }
.scene-impact summary { @apply tw:min-h-[44px] tw:cursor-pointer; font-weight: 650; }
.scene-impact ul { @apply tw:pl-s-5; margin-block: var(--s-2); }
.impact-list { scrollbar-gutter: stable; }
.impact-list li { margin-block: var(--s-2); }
.impact-list code { @apply tw:mr-s-2 tw:font-mono; }
.scene-impact button:disabled { @apply tw:text-disabled; opacity: 1; @apply tw:cursor-not-allowed; }
.scene-impact :is(button, summary, ul):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (max-width: 768px) { .impact-groups { grid-template-columns: minmax(0, 1fr); } }
</style>
