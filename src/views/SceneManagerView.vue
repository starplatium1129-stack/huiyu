<template>
  <article class="page catalog-studio" style="--page-max:1660px">
    <aside class="catalog-sidebar" aria-label="内容分类">
      <div class="catalog-brand"><ArchiveIcon name="manager" /><strong>内容工作室</strong></div>
      <div class="catalog-nav-group">
        <span class="catalog-nav-caption">创作资料</span>
        <button v-for="entry in kinds" :key="entry.value" type="button" :aria-current="section === 'records' && kind === entry.value ? 'page' : undefined" :disabled="busy || switchingSection" @click="switchKind(entry.value)">
          <ArchiveIcon :name="entry.icon" /><span>{{ entry.label }}</span><small>{{ counts[entry.value] ?? '—' }}</small>
        </button>
      </div>
      <div class="catalog-nav-group catalog-nav-secondary">
        <span class="catalog-nav-caption">整理与备份</span>
        <button type="button" :aria-current="section === 'portraits' ? 'page' : undefined" :disabled="busy || switchingSection" @click="switchSection('portraits')"><ArchiveIcon name="character" /><span>角色立绘</span></button>
        <button type="button" :aria-current="section === 'media' ? 'page' : undefined" :disabled="busy || switchingSection" @click="switchSection('media')"><ArchiveIcon name="gallery" /><span>样张与封面</span></button>
        <button type="button" :aria-current="section === 'bulk' ? 'page' : undefined" :disabled="busy || switchingSection" @click="switchSection('bulk')"><ArchiveIcon name="upload" /><span>批量整理</span></button>
        <button type="button" :aria-current="section === 'tools' ? 'page' : undefined" :disabled="busy || switchingSection" @click="switchSection('tools')"><ArchiveIcon name="download" /><span>文件与备份</span></button>
      </div>
    </aside>
    <div class="catalog-main" data-route-arrive>
      <!-- Save feedback follows Lucian #250; state and completion come from the catalog request. -->
      <header class="catalog-page-head" :class="{ 'has-changes': dirty }">
        <div><p class="catalog-breadcrumb">内容工作室 <span>/</span> {{ sectionTitle }}</p><h1 ref="pageTitle" tabindex="-1">{{ sectionTitle }}</h1></div>
        <div v-if="section === 'records' || dirty" class="catalog-head-actions">
          <span class="catalog-save-status" :class="{ 'has-changes': dirty }" role="status" aria-live="polite" aria-atomic="true"><span v-content-motion:down="saveStatus" class="catalog-save-status-content"><i aria-hidden="true"></i>{{ saveStatus }}</span></span>
          <button v-if="pending.length || dirtyEditor" class="btn btn-ghost" type="button" :disabled="busy" @click="reviewEdits">查看修改</button>
          <button class="btn btn-primary" type="button" :disabled="busy || (!pending.length && !dirtyEditor)" :data-loading="busy || undefined" :aria-busy="busy" @click="saveEdits">{{ busy ? '正在处理…' : '保存更改' }}</button>
          <StudioPopover label="更多整理操作">
            <template #trigger><button class="btn btn-ghost catalog-more-trigger" type="button" aria-label="更多整理操作"><ArchiveIcon name="chevron-down" /></button></template>
            <div class="catalog-more-menu">
              <button type="button" :disabled="busy" @click="refreshContent"><ArchiveIcon name="refresh" />刷新内容</button>
              <button type="button" @click="exportDraft"><ArchiveIcon name="download" />备份未保存的修改</button>
              <button type="button" :disabled="busy" @click="exportSnapshot"><ArchiveIcon name="download" />导出全部内容</button>
            </div>
          </StudioPopover>
        </div>
      </header>
      <p v-if="hint" class="catalog-feedback" role="status" aria-live="polite">{{ hint }}</p>
      <div v-if="section === 'portraits'" v-content-motion="section" class="catalog-support-surface"><AsyncPanel :loader="loadCharacterArt" label="角色立绘维护" v-slot="{ component }"><component :is="component" ref="artManager" :initial-character-id="typeof route.query.character === 'string' ? route.query.character : undefined" /></AsyncPanel></div>
      <div v-else-if="section === 'media'" v-content-motion="section" class="catalog-support-surface"><AsyncPanel :loader="loadCatalogMedia" label="样张与封面维护" v-slot="{ component }"><component :is="component" :record="selected" :character-names="characterNames" /></AsyncPanel></div>
      <section v-else-if="section === 'tools'" v-content-motion="section" class="catalog-support-surface">
        <h2>文件与备份</h2>
        <div class="catalog-tool-options">
          <button type="button" :disabled="busy" @click="exportSnapshot"><ArchiveIcon name="download" /><strong>导出全部内容</strong></button>
          <button type="button" :disabled="checking" @click="listBackups"><ArchiveIcon name="image" /><strong>查看图片备份</strong></button>
          <button type="button" :disabled="checking" @click="checkContent"><ArchiveIcon name="manager" /><strong>检查资料关联</strong></button>
        </div>
        <p class="catalog-feedback" role="status" aria-live="polite">{{ toolHint }}</p>
        <div v-for="entry in backups" :key="entry.id" class="catalog-history-row"><span>{{ entry.label }} · {{ catalogDate(entry.createdAt) }}</span><small>{{ entry.fileCount }} 个文件</small></div>
      </section>
      <section v-else-if="section === 'bulk'" v-content-motion="section" class="catalog-support-surface">
        <h2>批量整理</h2>
        <label class="catalog-file-picker"><ArchiveIcon name="upload" /><strong>选择整理文件</strong><span>JSON · 修改文件 / 完整备份</span><input type="file" accept="application/json,.json" aria-label="选择整理文件" @change="readBulkFile" /></label>
        <details class="catalog-advanced"><StudioDisclosureSummary>直接填写修改数据</StudioDisclosureSummary><div data-disclosure-content><textarea v-model="bulkInput" class="input catalog-bulk-input" rows="10" aria-label="修改数据"></textarea><button class="btn btn-ghost" type="button" :disabled="busy" @click="loadBulk">读取这些修改</button></div></details>
        <p v-if="bulkError" role="alert" class="catalog-error">{{ bulkError }}</p>
        <button v-if="selected && dirtyEditor" class="btn btn-ghost" type="button" @click="section = 'records'">继续编辑草稿</button>
        <div v-if="importSnapshot" class="catalog-actions"><span>已读取 {{ importSnapshot.records.length }} 份内容</span><button class="btn btn-ghost" type="button" :disabled="busy || dirty" @click="importContent(true)">看看导入的变化</button><button class="btn btn-primary" type="button" :disabled="busy || dirty || !importPreview" @click="importContent(false)">确认导入</button></div>
      </section>
      <template v-else>
        <div v-content-motion="`${section}:${kind}`" class="catalog-workspace">
          <section class="catalog-library" aria-label="内容列表" :aria-busy="loading">
            <header class="catalog-library-head"><div><h2>选一份内容</h2><span>{{ loading ? '正在读取…' : listMatchesKind ? (result?.total ?? 0) + ' 份' : '尚未读取' }}</span></div><button class="catalog-add" type="button" :disabled="busy || kind === 'document'" @click="add()" :aria-label="'新建' + sectionTitle"><ArchiveIcon name="plus" />新建</button></header>
            <StudioSearch ref="contentSearch" v-model="search" label="搜索内容" :placeholder="searchPlaceholder" />
            <div class="catalog-list-controls">
              <StudioSelect v-model="sort" label="排列方式" :options="sortOptions" />
              <StudioPopover label="筛选内容" align="start">
                <template #trigger><button class="catalog-filter-button" type="button" :class="{ active: hasFilters }"><ArchiveIcon name="manager" />筛选<span v-if="hasFilters" class="catalog-filter-dot"></span></button></template>
                <div class="catalog-filter-fields">
                  <StudioSelect v-model="character" label="角色" :options="[{ value: '', label: '全部角色' }, ...(listMatchesKind ? result?.facets.characters ?? [] : []).map(id => ({ value: id, label: characterNames[id] || '未命名角色' }))]" />
                  <StudioSelect v-model="category" label="分类" :options="[{ value: '', label: '全部分类' }, ...(listMatchesKind ? result?.facets.categories ?? [] : []).map(value => ({ value, label: catalogCategory(value) || value }))]" />
                  <StudioSelect v-model="rating" label="适用范围" :options="[{ value: '', label: '全部内容' }, ...(listMatchesKind ? result?.facets.ratings ?? [] : []).map(value => ({ value, label: catalogRating(value) || '其他内容' }))]" />
                  <button class="btn btn-ghost btn-sm" type="button" @click="character = ''; category = ''; rating = ''">清除筛选</button>
                </div>
              </StudioPopover>
            </div>
            <ArchiveStatePanel v-if="error" compact kind="error" title="内容暂时没能读出来" :message="error"><button class="btn btn-ghost btn-sm" type="button" @click="load">再试一次</button></ArchiveStatePanel>
            <div ref="recordList" v-content-motion:right="loading ? false : listScope" class="catalog-record-list">
              <button v-for="item in result?.items ?? []" :key="item.kind + ':' + item.id" class="catalog-record-row" type="button" :aria-pressed="selected?.id === item.id && selected.kind === item.kind" :disabled="busy || !listMatchesKind" @click="openContent(item, $event)">
                <span class="catalog-row-art"><RuntimeImage v-if="rowImage(item)" :src="rowImage(item)" v-slot="{ image, failed }"><img v-if="image.src && !failed" v-bind="image" loading="lazy" alt="" :class="{ 'is-mature': item.rating === 'R18' }" /><ArchiveIcon v-else :name="kindIcon(item.kind)" /></RuntimeImage><ArchiveIcon v-else :name="kindIcon(item.kind)" /></span>
                <span class="catalog-row-copy"><strong>{{ catalogTitle(item.kind, item.id, item.title) }}</strong><small>{{ rowSubtitle(item) }}</small></span>
                <span class="catalog-row-state"><ArchiveIcon v-if="selected?.id === item.id && selected.kind === item.kind" name="success" /><span v-if="isPending(item)" class="catalog-pending-dot" aria-label="有暂存修改"></span></span>
              </button>
              <ArchiveStatePanel v-if="!loading && !error && listMatchesKind && !result?.items.length" compact :kind="hasFilters || search ? 'filtered' : 'empty'" :title="hasFilters || search ? '没有匹配的内容' : '这里还没有内容'" :message="hasFilters || search ? '试试更短的关键词，或清除筛选重新找找。' : ''"><button v-if="hasFilters || search" class="btn btn-ghost btn-sm" type="button" @click="clearListFilters">清除搜索与筛选</button></ArchiveStatePanel>
            </div>
            <StudioPagination v-model="page" :pages="totalPages" :disabled="loading || !listMatchesKind" label="内容分页" />
          </section>
          <section ref="editorPane" v-content-motion:fade="detailLoading ? false : `${selected?.kind}:${selected?.id}`" class="catalog-editor-pane" tabindex="-1" aria-label="内容编辑" :aria-busy="detailLoading">
            <div v-if="detailLoading" class="catalog-editor-empty"><ArchiveIcon name="manager" /><h2>正在打开这份内容</h2></div>
            <template v-else-if="selected">
              <p v-if="editorPendingNotice" class="catalog-feedback" role="status">{{ editorPendingNotice }}</p>
              <CatalogRecordEditor v-model:record="selected" :disabled="busy || !!editorPendingNotice" :character-names="characterNames" :pending="pending" :dirty="dirtyEditor" @stage="stage" @duplicate="add(true)" @remove="archiveContent" />
              <details v-if="selected.revision" class="catalog-history" :aria-busy="historyLoading">
                <StudioDisclosureSummary>之前写过的版本</StudioDisclosureSummary>
                <p v-if="historyLoading" role="status">正在读取版本…</p>
                <div v-else-if="historyError" class="catalog-error" role="alert"><p>历史版本暂时无法读取：{{ historyError }}</p><button class="btn btn-ghost btn-sm" type="button" :disabled="busy" @click="retryHistory">重读版本</button></div>
                <p v-else-if="!history.length" class="catalog-note">暂无历史版本</p>
                <div v-for="entry in history" :key="entry.revision" class="catalog-history-row"><span>{{ catalogDate(entry.at) }}</span><button class="btn btn-ghost btn-sm" type="button" :disabled="busy || !!editorPendingNotice" @click="restore(entry.revision)">找回这一版</button></div>
                <button class="btn btn-ghost btn-sm" type="button" :disabled="busy" @click="compareCurrent">看看最新保存的内容</button>
              </details>
              <section v-if="currentServer" class="catalog-conflict"><h3>这份内容有了新修改</h3><p>你的草稿还在上面。对照最新内容，合并好以后再保存。</p><details><StudioDisclosureSummary>查看最新内容</StudioDisclosureSummary><pre>{{ JSON.stringify(currentServer.data, null, 2) }}</pre></details><button class="btn btn-ghost" type="button" :disabled="busy || !!editorPendingNotice" @click="adoptRevision">已核对，继续编辑</button></section>
            </template>
            <div v-else class="catalog-editor-empty"><img class="catalog-empty-illustration" :src="collectionArt" width="512" height="512" alt="" /><h2>翻开一份{{ sectionTitle }}</h2><p>从左侧选取，让角色与故事慢慢成册。</p><button v-if="kind !== 'document'" class="btn btn-ghost" type="button" :disabled="busy" @click="add()">新建内容</button></div>
          </section>
        </div>
      </template>
      <section v-if="pending.length" ref="pendingArea" class="catalog-review-area">
        <details :open="pendingOpen" @toggle="pendingOpen = ($event.target as HTMLDetailsElement).open"><StudioDisclosureSummary>{{ pending.length }} 项修改还没有保存</StudioDisclosureSummary><div data-disclosure-content><div v-for="(change, index) in pending" :key="change.kind + ':' + change.id" class="catalog-history-row"><span>{{ CATALOG_LABELS[change.kind] }} · {{ pendingTitle(change) }} <small>{{ change.remove ? '准备归档' : change.expectedRevision ? '已编辑' : '新建' }}</small></span><button class="btn btn-ghost btn-sm" type="button" :disabled="busy" @click="withdrawPending(change, index)">撤回这项</button></div></div></details>
      </section>
      <CatalogChangePreview v-if="preview" :preview="preview" />
    </div>
  </article>
</template>
<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import ArchiveStatePanel from '@/components/visual/ArchiveStatePanel.vue'
import ArchiveIcon, { type ArchiveIconName } from '@/components/visual/ArchiveIcon.vue'
import RuntimeImage from '@/components/visual/RuntimeImage.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import StudioPagination from '@/components/ui/StudioPagination.vue'
import StudioSearch from '@/components/ui/StudioSearch.vue'
import StudioPopover from '@/components/ui/StudioPopover.vue'
import AsyncPanel from '@/components/ui/AsyncPanel.vue'
import CatalogRecordEditor from '@/components/maintenance/CatalogRecordEditor.vue'
import CatalogChangePreview from '@/components/maintenance/CatalogChangePreview.vue'
import { useCatalogMaintenance } from '@/composables/scene/useCatalogMaintenance'
import { CATALOG_LABELS, catalogTitle, catalogRating, catalogCategory, catalogDate, recordTitle } from '@/composables/scene/catalogPresentation'
import type { CatalogChange, CatalogKind, CatalogSummary } from '@/api/catalogApi'
import { catalogApi } from '@/api/catalogApi'
import { maintenanceApi, type BackupEntry } from '@/api/maintenanceApi'
import { popularPortraitSrc } from '@/utils/popularPortraitSource'
import { catalogShowcaseId } from '@/utils/showcaseManifest'
import { useShowcaseAssets } from '@/composables/scene/useShowcaseAssets'
import { scrollBehavior } from '@/utils/motionPreference'
import collectionOriginal from '@/assets/illustrations/atelier-collection-spot.webp'
import { useThemeIllustration } from '@/composables/useThemeIllustration'
import '@/assets/css/catalog-maintenance.css'
const section = ref('records'), route = useRoute(), editorPane = ref<HTMLElement | null>(null)
const collectionArt = useThemeIllustration(collectionOriginal, 'collection')
const recordList = ref<HTMLElement | null>(null)
const contentSearch = ref<InstanceType<typeof StudioSearch> | null>(null)
const pageTitle = ref<HTMLElement | null>(null), pendingArea = ref<HTMLElement | null>(null), pendingOpen = ref(false)
const { thumbUrl, reload: reloadAssets } = useShowcaseAssets()
watch(section, value => { if (value === 'records') void reloadAssets().catch(() => {}) })
const loadCharacterArt = () => import('@/components/maintenance/CharacterArtManager.vue')
const artManager = ref<InstanceType<typeof import('@/components/maintenance/CharacterArtManager.vue')['default']> | null>(null)
const switchingSection = ref(false)
const loadCatalogMedia = () => import('@/components/maintenance/CatalogMediaManager.vue')
const checking = ref(false), toolHint = ref(''), backups = ref<BackupEntry[]>([])
const kinds: Array<{ value: CatalogKind; label: string; icon: ArchiveIconName }> = [
  { value: 'character', label: '角色档案', icon: 'character' }, { value: 'outfit', label: '服装方案', icon: 'image' },
  { value: 'scene', label: '场景故事', icon: 'scene' }, { value: 'blueprint', label: '场景蓝图', icon: 'spark' }, { value: 'document', label: '标签与推荐', icon: 'manager' },
]
const { kind, search, character, category, rating, sort, page, result, listScope, listMatchesKind, counts, loading, error, hint, selected, currentServer, detailLoading, pending, busy, preview, history, historyLoading, historyError, loadHistory, dirtyEditor, dirty, editorPendingNotice, totalPages, bulkInput, bulkError, importSnapshot, importPreview, importContent, load, select, add, stage, remove, withdrawPending: withdrawChange, submit, compareCurrent, adoptRevision, restore, loadBulk, readBulkFile: readBulkSource, exportDraft, exportSnapshot, characterNames } = useCatalogMaintenance()
watch(listScope, () => { recordList.value?.scrollTo(0, 0) }, { flush: 'post' })
watch(preview, value => { if (value) pendingOpen.value = true })
const sectionTitle = computed(() => section.value === 'records' ? CATALOG_LABELS[kind.value] : ({ portraits: '角色立绘', media: '样张与封面', bulk: '批量整理', tools: '文件与备份' } as Record<string, string>)[section.value])
const searchPlaceholder = computed(() => '找一份' + ({ character: '角色资料', outfit: '服装', scene: '故事', blueprint: '画面方案', document: '词库或推荐资料' } as Record<CatalogKind, string>)[kind.value] + '…')
const hasFilters = computed(() => !!(character.value || category.value || rating.value))
const saveStatus = computed(() => busy.value ? '正在处理…' : dirtyEditor.value ? '正在编辑 · 尚未保存' : pending.value.length ? pending.value.length + ' 项待保存' : '内容已保存')
const sortOptions = [{ value: 'order', label: '按整理顺序' }, { value: 'title', label: '按名称' }, { value: 'newest', label: '最近加入' }, { value: 'updated', label: '最近编辑' }]
function kindIcon(value: CatalogKind): ArchiveIconName { return kinds.find(entry => entry.value === value)!.icon }
function refreshContent() { void load(); void reloadAssets().catch(() => {}) }
async function clearListFilters() {
  search.value = ''; character.value = ''; category.value = ''; rating.value = ''
  await nextTick()
  contentSearch.value?.focus()
}
function rowImage(item: CatalogSummary) {
  if (item.kind === 'character') return popularPortraitSrc(item.id)
  if (item.kind === 'outfit') return popularPortraitSrc(item.characterId)
  if (item.kind === 'scene' || item.kind === 'blueprint') return thumbUrl(catalogShowcaseId(item))
  return ''
}
function rowSubtitle(item: CatalogSummary) {
  if (item.kind === 'document') return ({ tags: '常用关键词与显示名称', curation: '精选故事与展示顺序', 'tag-dictionary-policy': '让同义词指向正确的内容', 'prompt-pinned-scenes': '已确认的内容，在此查看', loras: '绘图资源，在此查看', 'retired-scenes': '保留已经归档的故事' } as Record<string, string>)[item.id] || '创作资料'
  const role = item.kind !== 'character' ? characterNames.value[item.characterId] : ''
  return [role, catalogCategory(item.category), item.rating === 'R18' ? catalogRating(item.rating) : ''].filter(Boolean).join(' · ') || CATALOG_LABELS[item.kind]
}
function isPending(item: CatalogSummary) { return pending.value.some(c => c.kind === item.kind && c.id === item.id) }
function retryHistory(event: MouseEvent) {
  const button = event.currentTarget
  if (button instanceof HTMLButtonElement && document.activeElement === button) button.closest('details')?.querySelector<HTMLElement>(':scope > summary')?.focus({ preventScroll: true })
  void loadHistory()
}
function pendingTitle(change: CatalogChange) {
  if (change.data) return recordTitle({ kind: change.kind, id: change.id, revision: change.expectedRevision, sortOrder: 0, createdAt: null, updatedAt: null, data: change.data })
  return catalogTitle(change.kind, change.id, result.value?.items.find(row => row.id === change.id)?.title || '选中的内容')
}
async function openContent(item: CatalogSummary, event: MouseEvent) {
  const intent = new AbortController()
  let interrupted = false
  const interrupt = () => { interrupted = true }
  // Loading can shrink a long editor and clamp scrollY. Only subsequent input
  // indicates that the user has moved on; layout changes must not cancel entry.
  for (const name of ['wheel', 'touchstart', 'pointerdown', 'keydown']) window.addEventListener(name, interrupt, { passive: true, signal: intent.signal })
  try {
    if (!await select(item)) return
    await nextTick()
    if (interrupted || selected.value?.kind !== item.kind || selected.value.id !== item.id || window.innerWidth > 1100) return
    if (event.detail === 0) editorPane.value?.focus({ preventScroll: true })
    editorPane.value?.scrollIntoView({ block: 'start', behavior: event.detail === 0 ? 'instant' : scrollBehavior() })
  } finally { intent.abort() }
}
async function archiveContent() {
  const source = document.activeElement
  await remove()
  await nextTick()
  if (!selected.value && source && !source.isConnected && document.activeElement === document.body)
    editorPane.value?.focus({ preventScroll: true })
}
async function withdrawPending(change: CatalogChange, index: number) {
  const previousFocus = document.activeElement
  if (!withdrawChange(change)) return
  const editor = selected.value, changes = pending.value, currentKind = kind.value, currentSection = section.value
  await nextTick()
  if (selected.value !== editor || pending.value !== changes || kind.value !== currentKind || section.value !== currentSection || detailLoading.value || busy.value) return
  if (!previousFocus || previousFocus.isConnected || document.activeElement !== document.body) return
  const buttons = pendingArea.value?.querySelectorAll<HTMLButtonElement>('button')
  const target = buttons?.[Math.min(index, buttons.length - 1)] || pageTitle.value
  target?.focus()
  if (target === pageTitle.value) target?.scrollIntoView({ block: 'center', behavior: 'instant' })
}
async function saveEdits() { if (dirtyEditor.value) stage(); if (!dirtyEditor.value) await submit(false) }
async function reviewEdits() { if (dirtyEditor.value) stage(); if (!dirtyEditor.value) await submit(true) }
async function checkContent() { checking.value = true; try { await catalogApi.check(); toolHint.value = '检查完成，资料关联完整' } catch (e) { toolHint.value = (e as Error).message } finally { checking.value = false } }
async function listBackups() { checking.value = true; try { backups.value = (await maintenanceApi.listBackups()).entries; toolHint.value = '找到 ' + backups.value.length + ' 份图片备份' } catch (e) { toolHint.value = (e as Error).message } finally { checking.value = false } }
async function switchSection(value: string) {
  if (busy.value || switchingSection.value) return false
  if (value === section.value) return true
  switchingSection.value = true
  try {
    if (artManager.value && !await artManager.value.canLeave()) return false
    section.value = value
    return true
  } finally { switchingSection.value = false }
}
async function switchKind(value: CatalogKind) {
  if (!await switchSection('records')) return
  kind.value = value; character.value = ''; category.value = ''; rating.value = ''
}
async function readBulkFile(event: Event) { const file = (event.target as HTMLInputElement).files?.[0]; if (file) await readBulkSource(file) }
onMounted(() => {
  if (route.query.tab === 'portraits') section.value = 'portraits'
  if (typeof route.query.created === 'string') { const id = route.query.created; kind.value = /^sc\d+$/.test(id) ? 'scene' : 'blueprint'; search.value = id; void select({ kind: kind.value, id }) }
})
</script>
