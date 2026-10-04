<template>
  <article class="page catalog-studio" style="--page-max:1660px">
    <aside class="catalog-sidebar" aria-label="内容分类">
      <div class="catalog-brand"><ArchiveIcon name="manager" /><div><strong>内容工作室</strong><span>让设定与故事慢慢成形</span></div></div>
      <div class="catalog-nav-group">
        <span class="catalog-nav-caption">创作资料</span>
        <button v-for="entry in kinds" :key="entry.value" type="button" :aria-current="section === 'records' && kind === entry.value ? 'page' : undefined" :disabled="busy" @click="switchKind(entry.value)">
          <ArchiveIcon :name="entry.icon" /><span>{{ entry.label }}</span><small>{{ counts[entry.value] ?? '—' }}</small>
        </button>
      </div>
      <div class="catalog-nav-group catalog-nav-secondary">
        <span class="catalog-nav-caption">整理与备份</span>
        <button type="button" :aria-current="section === 'portraits' ? 'page' : undefined" @click="section = 'portraits'"><ArchiveIcon name="character" /><span>角色立绘</span></button>
        <button type="button" :aria-current="section === 'media' ? 'page' : undefined" @click="section = 'media'"><ArchiveIcon name="gallery" /><span>样张与封面</span></button>
        <button type="button" :aria-current="section === 'bulk' ? 'page' : undefined" @click="section = 'bulk'"><ArchiveIcon name="upload" /><span>批量整理</span></button>
        <button type="button" :aria-current="section === 'tools' ? 'page' : undefined" @click="section = 'tools'"><ArchiveIcon name="download" /><span>文件与备份</span></button>
      </div>
      <p class="catalog-sidebar-note">先选一份内容，补充它的细节。<br />写好以后，记得保存更改。</p>
    </aside>
    <div class="catalog-main">
      <header class="catalog-page-head">
        <div><p class="catalog-breadcrumb">内容工作室 <span>/</span> {{ sectionTitle }}</p><h1>{{ sectionTitle }}</h1><p class="catalog-intro">{{ sectionDescription }}</p></div>
        <div v-if="section === 'records' || dirty" class="catalog-head-actions">
          <span class="catalog-save-status" :class="{ 'has-changes': dirty }" role="status" aria-live="polite"><i></i>{{ busy ? '正在保存' : dirtyEditor ? '正在编辑' : pending.length ? pending.length + ' 项待保存' : '内容已保存' }}</span>
          <button v-if="pending.length || dirtyEditor" class="btn btn-ghost" type="button" :disabled="busy" @click="reviewEdits">查看修改</button>
          <button class="btn btn-primary" type="button" :disabled="busy || (!pending.length && !dirtyEditor)" @click="saveEdits">{{ busy ? '正在保存…' : '保存更改' }}</button>
          <StudioPopover label="更多整理操作">
            <template #trigger><button class="btn btn-ghost catalog-more-trigger" type="button" aria-label="更多整理操作"><ArchiveIcon name="chevron-down" /></button></template>
            <div class="catalog-more-menu">
              <button type="button" :disabled="busy" @click="load"><ArchiveIcon name="refresh" />刷新内容</button>
              <button type="button" @click="exportDraft"><ArchiveIcon name="download" />备份未保存的修改</button>
              <button type="button" :disabled="busy" @click="exportSnapshot"><ArchiveIcon name="download" />导出全部内容</button>
            </div>
          </StudioPopover>
        </div>
      </header>
      <p v-if="hint" class="catalog-feedback" role="status" aria-live="polite">{{ hint }}</p>
      <div v-if="section === 'portraits'" class="catalog-support-surface"><CharacterArtManager :initial-character-id="typeof route.query.character === 'string' ? route.query.character : undefined" /></div>
      <div v-else-if="section === 'media'" class="catalog-support-surface"><CatalogMediaManager :record="selected" :character-names="characterNames" /></div>
      <section v-else-if="section === 'tools'" class="catalog-support-surface">
        <h2>给内容留一份备份</h2><p class="catalog-note">导出完整资料，或者看看之前的图片备份。每份内容的旧版本也可以在编辑区找回。</p>
        <div class="catalog-tool-options">
          <button type="button" :disabled="busy" @click="exportSnapshot"><ArchiveIcon name="download" /><strong>导出全部内容</strong><span>留存当前的角色、服装与故事资料</span></button>
          <button type="button" :disabled="checking" @click="listBackups"><ArchiveIcon name="image" /><strong>查看图片备份</strong><span>查看样张和封面的历史备份</span></button>
          <button type="button" :disabled="checking" @click="checkContent"><ArchiveIcon name="manager" /><strong>检查资料关联</strong><span>确认角色、服装和场景的引用是否完整</span></button>
        </div>
        <p class="catalog-feedback" role="status" aria-live="polite">{{ toolHint }}</p>
        <div v-for="entry in backups" :key="entry.id" class="catalog-history-row"><span>{{ entry.label }} · {{ catalogDate(entry.createdAt) }}</span><small>{{ entry.fileCount }} 个文件</small></div>
      </section>
      <section v-else-if="section === 'bulk'" class="catalog-support-surface">
        <h2>把准备好的修改带进来</h2><p class="catalog-note">选择修改文件或完整备份，先看看哪些内容会变化，再决定保存。</p>
        <label class="catalog-file-picker"><ArchiveIcon name="upload" /><strong>选择整理文件</strong><span>支持修改文件和完整内容备份</span><input type="file" accept="application/json,.json" aria-label="选择整理文件" @change="readBulkFile" /></label>
        <details class="catalog-advanced"><summary>直接填写修改数据</summary><textarea v-model="bulkInput" class="input catalog-bulk-input" rows="10" aria-label="修改数据"></textarea><button class="btn btn-ghost" type="button" :disabled="busy" @click="loadBulk">读取这些修改</button></details>
        <p v-if="bulkError" role="alert" class="catalog-error">{{ bulkError }}</p>
        <div v-if="importSnapshot" class="catalog-actions"><span>已读取 {{ importSnapshot.records.length }} 份内容</span><button class="btn btn-ghost" type="button" :disabled="busy || dirty" @click="importContent(true)">看看导入的变化</button><button class="btn btn-primary" type="button" :disabled="busy || dirty || !importPreview" @click="importContent(false)">确认导入</button></div>
      </section>
      <template v-else>
        <div class="catalog-workspace">
          <section class="catalog-library" aria-label="内容列表" :aria-busy="loading">
            <header class="catalog-library-head"><div><h2>选一份内容</h2><span>{{ loading ? '正在读取…' : (result?.total ?? 0) + ' 份' }}</span></div><button class="catalog-add" type="button" :disabled="busy || kind === 'document'" @click="add()" :aria-label="'新建' + sectionTitle"><span aria-hidden="true">＋</span>新建</button></header>
            <StudioSearch v-model="search" label="搜索内容" :placeholder="searchPlaceholder" />
            <div class="catalog-list-controls">
              <StudioSelect v-model="sort" label="排列方式" :options="sortOptions" />
              <StudioPopover label="筛选内容" align="start">
                <template #trigger><button class="catalog-filter-button" type="button" :class="{ active: hasFilters }"><ArchiveIcon name="manager" />筛选<span v-if="hasFilters" class="catalog-filter-dot"></span></button></template>
                <div class="catalog-filter-fields">
                  <StudioSelect v-model="character" label="角色" :options="[{ value: '', label: '全部角色' }, ...(result?.facets.characters ?? []).map(id => ({ value: id, label: characterNames[id] || '未命名角色' }))]" />
                  <StudioSelect v-model="category" label="分类" :options="[{ value: '', label: '全部分类' }, ...(result?.facets.categories ?? []).map(value => ({ value, label: catalogCategory(value) || value }))]" />
                  <StudioSelect v-model="rating" label="适用范围" :options="[{ value: '', label: '全部内容' }, ...(result?.facets.ratings ?? []).map(value => ({ value, label: catalogRating(value) || '其他内容' }))]" />
                  <button class="btn btn-ghost btn-sm" type="button" @click="character = ''; category = ''; rating = ''">清除筛选</button>
                </div>
              </StudioPopover>
            </div>
            <ArchiveStatePanel v-if="error" compact kind="error" title="内容暂时没能读出来" :message="error"><button class="btn btn-ghost btn-sm" type="button" @click="load">再试一次</button></ArchiveStatePanel>
            <div class="catalog-record-list">
              <button v-for="item in result?.items ?? []" :key="item.id" class="catalog-record-row" type="button" :aria-pressed="selected?.id === item.id && selected.kind === item.kind" :disabled="busy" @click="openContent(item)">
                <span class="catalog-row-art"><RuntimeImage v-if="rowImage(item)" :src="rowImage(item)" v-slot="{ image, failed }"><img v-if="image.src && !failed" v-bind="image" loading="lazy" alt="" :class="{ 'is-mature': item.rating === 'R18' }" /><ArchiveIcon v-else :name="kindIcon(item.kind)" /></RuntimeImage><ArchiveIcon v-else :name="kindIcon(item.kind)" /></span>
                <span class="catalog-row-copy"><strong>{{ catalogTitle(item.kind, item.id, item.title) }}</strong><small>{{ rowSubtitle(item) }}</small></span><span v-if="isPending(item)" class="catalog-pending-dot" aria-label="有暂存修改"></span>
              </button>
              <ArchiveStatePanel v-if="!loading && !error && !result?.items.length" compact kind="empty" title="这里还没有匹配的内容" message="换个关键词，或者从一份新内容开始。" />
            </div>
            <footer class="catalog-pagination"><button type="button" :disabled="loading || page <= 1" @click="page--" aria-label="上一页">上一页</button><span>{{ page }} / {{ totalPages }}</span><button type="button" :disabled="loading || page >= totalPages" @click="page++" aria-label="下一页">下一页</button></footer>
          </section>
          <section ref="editorPane" class="catalog-editor-pane" aria-label="内容编辑" :aria-busy="detailLoading">
            <div v-if="detailLoading" class="catalog-editor-empty"><ArchiveIcon name="manager" /><h2>正在打开这份内容</h2></div>
            <template v-else-if="selected">
              <CatalogRecordEditor v-model:record="selected" :disabled="busy" :character-names="characterNames" @stage="stage" @duplicate="add(true)" @remove="remove" />
              <details v-if="selected.revision" class="catalog-history"><summary>之前写过的版本</summary><div v-for="entry in history" :key="entry.revision" class="catalog-history-row"><span>{{ catalogDate(entry.at) }}</span><button class="btn btn-ghost btn-sm" type="button" :disabled="busy" @click="restore(entry.revision)">找回这一版</button></div><button class="btn btn-ghost btn-sm" type="button" :disabled="busy" @click="compareCurrent">看看最新保存的内容</button></details>
              <section v-if="currentServer" class="catalog-conflict"><h3>这份内容有了新修改</h3><p>你的草稿还在上面。对照最新内容，合并好以后再保存。</p><details><summary>查看最新内容</summary><pre>{{ JSON.stringify(currentServer.data, null, 2) }}</pre></details><button class="btn btn-ghost" type="button" :disabled="busy" @click="adoptRevision">已核对，继续编辑</button></section>
            </template>
            <div v-else class="catalog-editor-empty"><span class="catalog-empty-illustration"><ArchiveIcon :name="kindIcon(kind)" /></span><p>{{ sectionTitle }}</p><h2>挑一份内容，接着写</h2><span>从左侧选中它，补上设定、故事和画面细节。</span><button v-if="kind !== 'document'" class="btn btn-ghost" type="button" :disabled="busy" @click="add()">也可以从新内容开始</button></div>
          </section>
        </div>
      </template>
      <section v-if="pending.length" class="catalog-review-area">
        <details :open="!!preview"><summary>{{ pending.length }} 项修改还没有保存</summary><div v-for="(change, index) in pending" :key="change.kind + ':' + change.id" class="catalog-history-row"><span>{{ CATALOG_LABELS[change.kind] }} · {{ pendingTitle(change) }} <small>{{ change.remove ? '准备归档' : change.expectedRevision ? '已编辑' : '新建' }}</small></span><button class="btn btn-ghost btn-sm" type="button" :disabled="busy" @click="pending.splice(index, 1)">撤回这项</button></div></details>
      </section>
      <CatalogChangePreview v-if="preview" :preview="preview" />
    </div>
  </article>
</template>
<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import ArchiveStatePanel from '@/components/visual/ArchiveStatePanel.vue'
import ArchiveIcon, { type ArchiveIconName } from '@/components/visual/ArchiveIcon.vue'
import RuntimeImage from '@/components/visual/RuntimeImage.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioSearch from '@/components/ui/StudioSearch.vue'
import StudioPopover from '@/components/ui/StudioPopover.vue'
import CatalogRecordEditor from '@/components/maintenance/CatalogRecordEditor.vue'
import CatalogChangePreview from '@/components/maintenance/CatalogChangePreview.vue'
import { useCatalogMaintenance } from '@/composables/scene/useCatalogMaintenance'
import { CATALOG_LABELS, catalogTitle, catalogRating, catalogCategory, catalogDate, recordTitle } from '@/composables/scene/catalogPresentation'
import type { CatalogChange, CatalogKind, CatalogSummary } from '@/api/catalogApi'
import { catalogApi } from '@/api/catalogApi'
import { maintenanceApi, type BackupEntry } from '@/api/maintenanceApi'
import { popularPortraitSrc } from '@/utils/popularPortraitSource'
import '@/assets/css/catalog-maintenance.css'
const section = ref('records'), route = useRoute(), editorPane = ref<HTMLElement | null>(null)
const CharacterArtManager = defineAsyncComponent(() => import('@/components/maintenance/CharacterArtManager.vue'))
const CatalogMediaManager = defineAsyncComponent(() => import('@/components/maintenance/CatalogMediaManager.vue'))
const checking = ref(false), toolHint = ref(''), backups = ref<BackupEntry[]>([])
const kinds: Array<{ value: CatalogKind; label: string; icon: ArchiveIconName }> = [
  { value: 'character', label: '角色档案', icon: 'character' }, { value: 'outfit', label: '服装方案', icon: 'image' },
  { value: 'scene', label: '场景故事', icon: 'scene' }, { value: 'blueprint', label: '场景蓝图', icon: 'spark' }, { value: 'document', label: '标签与推荐', icon: 'manager' },
]
const { kind, search, character, category, rating, sort, page, result, counts, loading, error, hint, selected, currentServer, detailLoading, pending, busy, preview, history, dirtyEditor, dirty, totalPages, bulkInput, bulkError, importSnapshot, importPreview, importContent, load, select, add, stage, remove, submit, compareCurrent, adoptRevision, restore, loadBulk, exportDraft, exportSnapshot, characterNames } = useCatalogMaintenance()
const sectionTitle = computed(() => section.value === 'records' ? CATALOG_LABELS[kind.value] : ({ portraits: '角色立绘', media: '样张与封面', bulk: '批量整理', tools: '文件与备份' } as Record<string, string>)[section.value])
const sectionDescription = computed(() => section.value === 'media' ? '找到场景、替换样张，或者为首页换一张封面。' : section.value !== 'records' ? '把创作资料整理好，留给下一次灵感。' : ({ character: '补充人物的来历与外观，让角色的样子更清晰。', outfit: '整理服装的样子与细节，为角色留住不同的形态。', scene: '写下故事与画面细节，让下一次创作更有依据。', blueprint: '把动作、氛围和镜头整理成一份可用的画面方案。', document: '整理常用词与推荐顺序，让内容更容易被找到。' } as Record<CatalogKind, string>)[kind.value])
const searchPlaceholder = computed(() => '找一份' + ({ character: '角色资料', outfit: '服装', scene: '故事', blueprint: '画面方案', document: '词库或推荐资料' } as Record<CatalogKind, string>)[kind.value] + '…')
const hasFilters = computed(() => !!(character.value || category.value || rating.value))
const sortOptions = [{ value: 'order', label: '按整理顺序' }, { value: 'title', label: '按名称' }, { value: 'newest', label: '最近加入' }, { value: 'updated', label: '最近编辑' }]
function kindIcon(value: CatalogKind): ArchiveIconName { return kinds.find(entry => entry.value === value)!.icon }
function rowImage(item: CatalogSummary) {
  if (item.kind === 'character') return popularPortraitSrc(item.id)
  if (item.kind === 'outfit') return popularPortraitSrc(item.characterId)
  if (item.kind === 'scene') return '/scene-showcase/thumbs/' + encodeURIComponent(item.id) + '.jpg'
  if (item.kind === 'blueprint') return '/scene-showcase/thumbs/pc_' + encodeURIComponent(item.characterId) + '_' + encodeURIComponent(item.id) + '.jpg'
  return ''
}
function rowSubtitle(item: CatalogSummary) {
  if (item.kind === 'document') return ({ tags: '常用关键词与显示名称', curation: '精选故事与展示顺序', 'tag-dictionary-policy': '让同义词指向正确的内容', 'prompt-pinned-scenes': '已确认的内容，在此查看', loras: '绘图资源，在此查看', 'retired-scenes': '保留已经归档的故事' } as Record<string, string>)[item.id] || '创作资料'
  const role = item.kind !== 'character' ? characterNames.value[item.characterId] : ''
  return [role, catalogCategory(item.category), item.rating === 'R18' ? catalogRating(item.rating) : ''].filter(Boolean).join(' · ') || CATALOG_LABELS[item.kind]
}
function isPending(item: CatalogSummary) { return pending.value.some(c => c.kind === item.kind && c.id === item.id) }
function pendingTitle(change: CatalogChange) {
  if (change.data) return recordTitle({ kind: change.kind, id: change.id, revision: change.expectedRevision, sortOrder: 0, createdAt: null, updatedAt: null, data: change.data })
  return catalogTitle(change.kind, change.id, result.value?.items.find(row => row.id === change.id)?.title || '选中的内容')
}
async function openContent(item: CatalogSummary) { await select(item); if (window.innerWidth < 1100) editorPane.value?.scrollIntoView({ block: 'start' }) }
async function saveEdits() { if (dirtyEditor.value) stage(); if (!dirtyEditor.value) await submit(false) }
async function reviewEdits() { if (dirtyEditor.value) stage(); if (!dirtyEditor.value) await submit(true) }
async function checkContent() { checking.value = true; try { await catalogApi.check(); toolHint.value = '检查完成，资料关联完整' } catch (e) { toolHint.value = (e as Error).message } finally { checking.value = false } }
async function listBackups() { checking.value = true; try { backups.value = (await maintenanceApi.listBackups()).entries; toolHint.value = '找到 ' + backups.value.length + ' 份图片备份' } catch (e) { toolHint.value = (e as Error).message } finally { checking.value = false } }
function switchKind(value: CatalogKind) { kind.value = value; character.value = ''; category.value = ''; rating.value = ''; section.value = 'records' }
async function readBulkFile(event: Event) { const file = (event.target as HTMLInputElement).files?.[0]; if (file) { bulkInput.value = await file.text(); loadBulk() } }
onMounted(() => {
  if (route.query.tab === 'portraits') section.value = 'portraits'
  if (typeof route.query.created === 'string') { const id = route.query.created; kind.value = /^sc\d+$/.test(id) ? 'scene' : 'blueprint'; search.value = id; void select({ kind: kind.value, id }) }
})
</script>
