<template>
  <article class="page catalog-studio" style="--page-max:1660px">
    <nav ref="navigation" class="catalog-sidebar" aria-label="内容维护导航">
      <template v-if="compact">
        <label for="catalog-destination">资料目录</label>
        <StudioSelect id="catalog-destination" :model-value="section === 'records' ? kind : section"
          :groups="destinations" label="资料目录" :disabled="busy || switchingSection" @update:model-value="navigateTo(String($event))" />
      </template>
      <template v-else>
      <RouterLink to="/" class="catalog-brand"><BrandLogo class="catalog-brand-logo" /><strong>资料目录</strong></RouterLink>
      <div class="catalog-nav-group">
        <span class="catalog-nav-caption">创作资料</span>
        <button v-for="entry in kinds" :key="entry.value" type="button" :aria-current="section === 'records' && kind === entry.value ? 'page' : undefined" :disabled="busy || switchingSection" @click="switchKind(entry.value)">
          <ArchiveIcon :name="entry.icon" /><span>{{ entry.label }}</span><small>{{ counts[entry.value] ?? '—' }}</small>
        </button>
      </div>
      <div class="catalog-nav-group catalog-nav-secondary">
        <span class="catalog-nav-caption">整理与备份</span>
        <button v-for="tool in supportSections" :key="tool.value" type="button" :aria-current="section === tool.value ? 'page' : undefined"
          :disabled="busy || switchingSection" @click="switchSection(tool.value)"><ArchiveIcon :name="tool.icon" /><span>{{ tool.label }}</span></button>
      </div>
      </template>
    </nav>
    <div class="catalog-main" data-route-arrive>
      <header class="catalog-page-head" :class="{ 'has-changes': dirty }">
        <div class="catalog-heading"><p>内容维护</p><h1 ref="pageTitle" tabindex="-1">{{ sectionTitle }}</h1></div>
        <div v-if="section === 'records' || dirty" class="catalog-head-actions">
          <span v-if="selected || dirty" class="catalog-save-status" :class="{ 'has-changes': dirty }" role="status" aria-atomic="true"><span v-content-motion:down="saveStatus" class="catalog-save-status-content">{{ saveStatus }}</span></span>
          <button v-if="dirty" class="btn btn-ghost" type="button" :disabled="busy || detailLoading" @click="reviewEdits">查看修改</button>
          <button v-if="selected || dirty" class="btn btn-primary" type="button" :disabled="busy || detailLoading || !dirty" :data-loading="busy || undefined" :aria-busy="busy" @click="saveEdits">{{ busy ? '正在处理…' : '保存更改' }}</button>
          <StudioPopover label="更多整理操作">
            <template #trigger><button class="btn btn-ghost" type="button"><ArchiveIcon name="manager" />整理操作</button></template>
            <div class="catalog-more-menu">
              <button type="button" :disabled="busy" @click="refreshContent"><ArchiveIcon name="refresh" />刷新内容</button>
              <button type="button" @click="exportDraft"><ArchiveIcon name="download" />备份未保存的修改</button>
              <button type="button" :disabled="busy" @click="exportSnapshot"><ArchiveIcon name="download" />下载内容库备份</button>
            </div>
          </StudioPopover>
        </div>
      </header>
      <p v-if="hint" class="catalog-feedback" role="status" aria-live="polite">{{ hint }}</p>
      <div v-if="lastOnboardedCharacter" class="catalog-feedback catalog-onboarding-next" role="status"><span>{{ characterNames[lastOnboardedCharacter] || lastOnboardedCharacter }}与首套服装已保存。</span><button class="btn btn-primary btn-sm" type="button" :disabled="busy || dirty" @click="addBlueprintFor(lastOnboardedCharacter)">继续创建蓝图</button><button class="btn btn-quiet btn-sm" type="button" @click="lastOnboardedCharacter = ''">稍后再说</button></div>
      <div v-if="section === 'portraits'" v-content-motion="section" class="catalog-support-surface"><AsyncPanel :loader="loadCharacterArt" label="角色立绘维护" v-slot="{ component }"><component :is="component" ref="artManager" :initial-character-id="typeof route.query.character === 'string' ? route.query.character : undefined" /></AsyncPanel></div>
      <div v-else-if="section === 'media'" v-content-motion="section" class="catalog-support-surface"><AsyncPanel :loader="loadCatalogMedia" label="样张与封面维护" v-slot="{ component }"><component :is="component" :record="selected" :character-names="characterNames" /></AsyncPanel></div>
      <section v-else-if="section === 'tools'" v-content-motion="section" class="catalog-support-surface">
        <div class="catalog-tool-options">
          <button type="button" :disabled="busy" @click="exportSnapshot"><ArchiveIcon name="download" /><strong>下载内容库备份</strong></button>
          <button type="button" :disabled="checking" @click="listBackups"><ArchiveIcon name="image" /><strong>查看图片备份</strong></button>
          <button type="button" :disabled="checking" @click="checkContent"><ArchiveIcon name="manager" /><strong>检查资料关联</strong></button>
        </div>
        <p class="catalog-feedback" role="status" aria-live="polite">{{ toolHint }}</p>
        <div v-for="entry in backups" :key="entry.id" class="catalog-history-row"><span>{{ entry.label }} · {{ catalogDate(entry.createdAt) }}</span><small>{{ entry.fileCount }} 个文件</small></div>
      </section>
      <section v-else-if="section === 'bulk'" v-content-motion="section" class="catalog-support-surface">
        <label class="catalog-file-picker"><ArchiveIcon name="upload" /><strong>选择整理文件</strong><span>JSON · 修改文件 / 完整备份</span><input type="file" accept="application/json,.json" aria-label="选择整理文件" @change="readBulkFile" /></label>
        <details class="catalog-advanced"><StudioDisclosureSummary>直接填写修改数据</StudioDisclosureSummary><div data-disclosure-content><textarea v-model="bulkInput" class="input catalog-bulk-input" rows="10" aria-label="修改数据"></textarea><button class="btn btn-ghost" type="button" :disabled="busy" @click="loadBulk">读取这些修改</button></div></details>
        <p v-if="bulkError" role="alert" class="catalog-error">{{ bulkError }}</p>
        <button v-if="selected && dirtyEditor" class="btn btn-ghost" type="button" @click="resumeEditor">继续编辑草稿</button>
        <div v-if="importSnapshot" class="catalog-actions"><span>已读取 {{ importSnapshot.records.length }} 项</span><button class="btn btn-ghost" type="button" :disabled="busy || dirty" @click="importContent(true)">预览导入</button><button class="btn btn-primary" type="button" :disabled="busy || dirty || !importPreview" @click="importContent(false)">确认导入</button></div>
      </section>
      <template v-else>
        <div v-content-motion="`${section}:${kind}`" class="catalog-workspace" :class="{ 'is-editing': showEditor }">
          <section v-show="libraryVisible" ref="libraryPane" class="catalog-library" aria-label="内容列表" :aria-busy="loading">
            <header class="catalog-library-head">
              <div><h2>资料列表</h2><span role="status">{{ listStatus }}</span></div>
              <div class="catalog-library-actions">
                <button v-if="selected && !showEditor" class="btn btn-ghost btn-sm" type="button" :disabled="busy" @click="resumeEditor">继续编辑</button>
                <button v-if="kind === 'character'" class="btn btn-ghost btn-sm" type="button" :disabled="busy" @click="newRecord(true)">接入绘图角色</button>
                <button v-if="kind !== 'document'" class="btn btn-primary btn-sm" type="button" :disabled="busy" @click="newRecord()"><ArchiveIcon name="plus" />新建{{ sectionTitle }}</button>
              </div>
            </header>
            <CatalogListFilters ref="listFilters" v-model:search="search" v-model:sort="sort" v-model:character="character"
              v-model:category="category" v-model:rating="rating" :facets="listMatchesKind ? result?.facets : undefined"
              :character-names="characterNames" :visible="libraryVisible" />
            <ArchiveStatePanel v-if="error" compact kind="error" title="内容读取失败" :message="error"><button class="btn btn-ghost btn-sm" type="button" @click="load">重新读取</button></ArchiveStatePanel>
            <div ref="recordList" v-content-motion:right="loading ? false : listScope" class="catalog-record-list">
              <ArchiveStatePanel v-if="loading && !listMatchesKind" compact kind="loading" title="正在读取资料" />
              <StudioTooltip
                v-for="item in listMatchesKind ? result?.items : []"
                :key="item.kind + ':' + item.id"
                anchor
                :content="`${catalogTitle(item.kind, item.id, item.title)} · ${rowSubtitle(item)}`"
              >
                <button class="catalog-record-row" type="button" :aria-pressed="selected?.id === item.id && selected.kind === item.kind" :disabled="busy" @click="openContent(item, $event)">
                  <span class="catalog-row-art"><RuntimeImage v-if="rowImage(item)" :src="rowImage(item)" v-slot="{ image, failed }"><img v-if="image.src && !failed" v-bind="image" loading="lazy" alt="" :class="{ 'is-mature': rowSampleRating(item) === 'R18' }" /><ArchiveIcon v-else :name="kindIcon(item.kind)" /></RuntimeImage><ArchiveIcon v-else :name="kindIcon(item.kind)" /></span>
                  <span class="catalog-row-copy"><strong>{{ catalogTitle(item.kind, item.id, item.title) }}</strong><small>{{ rowSubtitle(item) }}</small></span>
                  <span v-if="pendingIds.has(item.id) || selected?.id === item.id && selected.kind === item.kind" class="catalog-row-state"><ArchiveIcon v-if="selected?.id === item.id && selected.kind === item.kind" name="success" /><small v-if="pendingIds.has(item.id)">暂存</small></span>
                </button>
              </StudioTooltip>
              <ArchiveStatePanel v-if="!loading && !error && listMatchesKind && !result?.items.length" compact :kind="filtered ? 'filtered' : 'empty'" :title="filtered ? '未找到匹配内容' : '暂无' + sectionTitle"><button v-if="filtered" class="btn btn-ghost btn-sm" type="button" @click="listFilters?.clearAll()">清除搜索与筛选</button></ArchiveStatePanel>
            </div>
            <StudioPagination v-if="totalPages > 1" v-model="page" :pages="totalPages" :disabled="loading" label="内容分页" />
          </section>
          <section v-show="showEditor" ref="editorPane" v-content-motion:fade="detailLoading ? false : editorSession" class="catalog-editor-pane" tabindex="-1" aria-label="内容编辑" :aria-busy="detailLoading">
            <button class="btn btn-quiet btn-sm catalog-back" type="button" @click="returnToList"><ArchiveIcon name="chevron-down" />返回资料列表</button>
            <ArchiveStatePanel v-if="detailLoading" compact kind="loading" title="正在打开资料" />
            <template v-else-if="selected">
              <div class="catalog-editor-preview-strip" aria-label="当前资料角色与样张预览">
                <span class="catalog-preview-strip-thumb">
                  <RuntimeImage v-if="selectedPreviewImage" :src="selectedPreviewImage" v-slot="{ image, failed }">
                    <img v-if="image.src && !failed" v-bind="image" alt="" :class="{ 'is-mature': selectedPreviewAdult }" />
                    <ArchiveIcon v-else :name="kindIcon(selected.kind)" />
                  </RuntimeImage>
                  <ArchiveIcon v-else :name="kindIcon(selected.kind)" />
                </span>
                <div class="catalog-preview-strip-copy">
                  <div class="catalog-preview-strip-badges">
                    <span class="catalog-preview-badge">{{ CATALOG_LABELS[selected.kind] }}</span>
                    <span v-if="selectedCharacterLabel" class="catalog-preview-badge is-character">{{ selectedCharacterLabel }}</span>
                    <span v-if="selectedCategoryLabel" class="catalog-preview-badge">{{ selectedCategoryLabel }}</span>
                    <span v-if="selectedPreviewAdult" class="catalog-preview-badge is-adult">成人分级</span>
                  </div>
                  <strong class="catalog-preview-strip-title">{{ recordTitle(selected) }}</strong>
                </div>
              </div>
              <p v-if="editorPendingNotice" class="catalog-feedback" role="status">{{ editorPendingNotice }}</p>
              <CatalogRecordEditor :key="editorSession" v-model:record="selected" :advanced="advanced" :advanced-error="advancedError" :field-error="fieldError" :editor-session="editorSession" @advanced="updateAdvanced" @apply-advanced="applyAdvanced" @discard-advanced="discardAdvanced" @field-input="clearFieldError" :disabled="busy || !!editorPendingNotice" :character-names="characterNames" :pending="pending" :dirty="dirtyEditor" @stage="stage" @duplicate="add(true)" @remove="archiveContent" />
              <details v-if="selected.revision" class="catalog-history" :aria-busy="historyLoading">
                <StudioDisclosureSummary>历史版本</StudioDisclosureSummary>
                <p v-if="historyLoading" role="status">正在读取版本…</p>
                <div v-else-if="historyError" class="catalog-error" role="alert"><p>历史版本读取失败：{{ historyError }}</p><button class="btn btn-ghost btn-sm" type="button" :disabled="busy" @click="retryHistory">重读版本</button></div>
                <p v-else-if="!history.length" class="catalog-note">暂无历史版本</p>
                <div v-for="entry in history" :key="entry.revision" class="catalog-history-row"><span>{{ catalogDate(entry.at) }}</span><button class="btn btn-ghost btn-sm" type="button" :disabled="busy || !!editorPendingNotice" @click="restore(entry.revision)">恢复此版本</button></div>
                <button class="btn btn-ghost btn-sm" type="button" :disabled="busy" @click="compareCurrent">查看最新保存</button>
              </details>
              <section v-if="currentServer" class="catalog-conflict"><h3>{{ currentServer.revision === selected.revision ? '最新保存的版本' : '内容版本冲突' }}</h3><p>当前编辑基于第 {{ selected.revision }} 版，内容库已保存第 {{ currentServer.revision }} 版。</p><details><StudioDisclosureSummary>查看已保存内容</StudioDisclosureSummary><pre>{{ JSON.stringify(currentServer.data, null, 2) }}</pre></details><button v-if="currentServer.revision !== selected.revision" class="btn btn-ghost" type="button" :disabled="busy || !!editorPendingNotice" @click="adoptRevision">已核对，继续编辑</button></section>
            </template>
          </section>
        </div>
      </template>
      <section v-if="pending.length" ref="pendingArea" class="catalog-review-area">
        <details :open="pendingOpen" @toggle="pendingOpen = ($event.target as HTMLDetailsElement).open"><StudioDisclosureSummary>{{ pending.length }} 项修改还没有保存</StudioDisclosureSummary><div data-disclosure-content><div v-for="(change, index) in pending" :key="change.kind + ':' + change.id" class="catalog-history-row"><span>{{ CATALOG_LABELS[change.kind] }} · {{ pendingTitle(change) }} <small>{{ change.remove ? '准备归档' : change.expectedRevision ? '已编辑' : '新建' }}</small></span><button class="btn btn-ghost btn-sm" type="button" :disabled="busy" @click="withdrawPending(change, index)">撤回这项</button></div></div></details>
      </section>
      <div v-if="preview" ref="reviewArea" tabindex="-1" aria-label="修改预览" role="region"><CatalogChangePreview :preview="preview" /></div>
    </div>
  </article>
</template>
<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onMounted, ref, watch } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import { useRoute } from 'vue-router'
import ArchiveStatePanel from '@/components/visual/ArchiveStatePanel.vue'
import ArchiveIcon, { type ArchiveIconName } from '@/components/visual/ArchiveIcon.vue'
import BrandLogo from '@/components/BrandLogo.vue'
import RuntimeImage from '@/components/visual/RuntimeImage.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioPagination from '@/components/ui/StudioPagination.vue'
import StudioPopover from '@/components/ui/StudioPopover.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import AsyncPanel from '@/components/ui/AsyncPanel.vue'
import CatalogRecordEditor from '@/components/maintenance/CatalogRecordEditor.vue'
import CatalogListFilters from '@/components/maintenance/CatalogListFilters.vue'
const CatalogChangePreview = defineAsyncComponent(() => import('@/components/maintenance/CatalogChangePreview.vue'))
import { useCatalogMaintenance } from '@/composables/scene/useCatalogMaintenance'
import { CATALOG_LABELS, catalogTitle, catalogRating, catalogCategory, catalogDate, recordTitle } from '@/composables/scene/catalogPresentation'
import type { CatalogChange, CatalogKind, CatalogSummary } from '@/api/catalogApi'
import { catalogApi } from '@/api/catalogApi'
import type { BackupEntry } from '@/api/maintenanceApi'
import { popularPortraitSrc } from '@/utils/popularPortraitSource'
import { catalogShowcaseId } from '@/utils/showcaseManifest'
import { useShowcaseAssets } from '@/composables/scene/useShowcaseAssets'
import { scrollBehavior } from '@/utils/motionPreference'
import '@/assets/css/catalog-maintenance.css'
const section = ref('records'), route = useRoute(), editorPane = ref<HTMLElement | null>(null)
const recordList = ref<HTMLElement | null>(null)
const libraryPane = ref<HTMLElement | null>(null), reviewArea = ref<HTMLElement | null>(null)
const navigation = ref<HTMLElement | null>(null)
const listFilters = ref<InstanceType<typeof CatalogListFilters> | null>(null)
const compact = useMediaQuery('(max-width: 820px)')
const browsing = ref(true)
const pageTitle = ref<HTMLElement | null>(null), pendingArea = ref<HTMLElement | null>(null), pendingOpen = ref(false)
const { entryFor, thumbUrl, reload: reloadAssets } = useShowcaseAssets()
watch(section, value => { if (value === 'records') void reloadAssets().catch(() => {}) })
const loadCharacterArt = () => import('@/components/maintenance/CharacterArtManager.vue')
const artManager = ref<InstanceType<typeof import('@/components/maintenance/CharacterArtManager.vue')['default']> | null>(null)
const switchingSection = ref(false)
const loadCatalogMedia = () => import('@/components/maintenance/CatalogMediaManager.vue')
const checking = ref(false), toolHint = ref(''), backups = ref<BackupEntry[]>([])
const kinds: Array<{ value: CatalogKind; label: string; icon: ArchiveIconName }> = [
  { value: 'character', label: '角色档案', icon: 'character' }, { value: 'outfit', label: '服装方案', icon: 'wardrobe' },
  { value: 'scene', label: '场景故事', icon: 'scene' }, { value: 'blueprint', label: '场景蓝图', icon: 'spark' }, { value: 'document', label: '标签与推荐', icon: 'manager' },
]
const supportSections = [
  { value: 'portraits', label: '角色立绘', icon: 'character' }, { value: 'media', label: '样张与封面', icon: 'gallery' },
  { value: 'bulk', label: '批量整理', icon: 'upload' }, { value: 'tools', label: '文件与备份', icon: 'download' },
] as const
const { kind, changeKind, search, character, category, rating, sort, page, result, listScope, listMatchesKind, counts, loading, error, hint, selected, currentServer, detailLoading, pending, busy, preview, history, historyLoading, historyError, loadHistory, advanced, advancedError, fieldError, editorSession, updateAdvanced, applyAdvanced, discardAdvanced, dirtyEditor, dirty, editorPendingNotice, totalPages, bulkInput, bulkError, importSnapshot, importPreview, importContent, load, select, add, stage, remove, withdrawPending: withdrawChange, submit, compareCurrent, adoptRevision, lastOnboardedCharacter, restore, loadBulk, readBulkFile: readBulkSource, exportDraft, exportSnapshot, characterNames } = useCatalogMaintenance(editorPane)
watch(listScope, () => { recordList.value?.scrollTo(0, 0) }, { flush: 'post' })
watch(preview, value => { if (value) pendingOpen.value = true })
const sectionTitle = computed(() => section.value === 'records' ? CATALOG_LABELS[kind.value] : supportSections.find(tool => tool.value === section.value)?.label)
const destinations = computed(() => [
  { label: '创作资料', options: kinds.map(item => ({ value: item.value, label: item.label + (counts.value[item.value] === undefined ? '' : ' · ' + counts.value[item.value]) })) },
  { label: '整理与备份', options: supportSections },
])
const showEditor = computed(() => !!selected.value && !browsing.value)
const libraryVisible = computed(() => !compact.value || !showEditor.value)
const filtered = computed(() => !!(search.value || character.value || category.value || rating.value))
const pendingIds = computed(() => new Set(pending.value.filter(change => change.kind === kind.value).map(change => change.id)))
const listStatus = computed(() => {
  if (loading.value) return '正在读取…'
  if (detailLoading.value && !showEditor.value) return '正在打开资料…'
  if (!listMatchesKind.value || !result.value) return ''
  return (filtered.value ? '匹配 ' : '共 ') + result.value.total + ' 项'
})
const saveStatus = computed(() => busy.value ? '正在处理…' : dirtyEditor.value ? '编辑未保存' : pending.value.length ? pending.value.length + ' 项待保存' : selected.value?.revision ? '已保存' : '新建草稿')
function kindIcon(value: CatalogKind): ArchiveIconName { return kinds.find(entry => entry.value === value)!.icon }
function refreshContent() { void load(); void reloadAssets().catch(() => {}) }
async function focusEditor() {
  await nextTick()
  if (section.value !== 'records' || !showEditor.value) return
  editorPane.value?.focus({ preventScroll: true })
  editorPane.value?.scrollIntoView({ block: 'start', behavior: 'instant' })
}
async function resumeEditor() {
  if (!await switchSection('records')) return
  browsing.value = false
  await focusEditor()
}
async function newRecord(popular = false) {
  if (await add(false, popular)) await resumeEditor()
}
async function returnToList() {
  browsing.value = true
  await nextTick()
  const row = recordList.value?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]:enabled')
  if (row) row.focus()
  else listFilters.value?.focusSearch()
}
watch(compact, async value => {
  if (value && showEditor.value && libraryPane.value?.contains(document.activeElement)) browsing.value = true
  if (navigation.value?.contains(document.activeElement)) {
    await nextTick()
    navigation.value?.querySelector<HTMLElement>('[role="combobox"], [aria-current="page"]')?.focus({ preventScroll: true })
  }
})
function rowImage(item: CatalogSummary) {
  if (item.kind === 'character') return popularPortraitSrc(item.id)
  if (item.kind === 'outfit') return popularPortraitSrc(item.characterId)
  if (item.kind === 'scene' || item.kind === 'blueprint') return thumbUrl(catalogShowcaseId(item))
  return ''
}
function rowSampleRating(item: CatalogSummary) {
  return item.kind === 'scene' || item.kind === 'blueprint' ? entryFor(catalogShowcaseId(item))?.rating ?? item.rating : item.rating
}
const selectedDataRecord = computed(() => (selected.value?.data && typeof selected.value.data === 'object' ? selected.value.data as Record<string, unknown> : null))
const selectedCharacterId = computed(() => {
  if (!selected.value) return ''
  if (selected.value.kind === 'character') return selected.value.id
  const raw = selectedDataRecord.value?.characterId
  return typeof raw === 'string' ? raw : ''
})
const selectedCharacterLabel = computed(() => {
  const id = selectedCharacterId.value
  return id ? (characterNames.value[id] || id) : ''
})
const selectedCategoryLabel = computed(() => {
  const raw = selectedDataRecord.value?.category
  return typeof raw === 'string' && raw ? catalogCategory(raw) : ''
})
const selectedPreviewImage = computed(() => {
  if (!selected.value) return ''
  if (selected.value.kind === 'character') return popularPortraitSrc(selected.value.id)
  if (selected.value.kind === 'outfit') return popularPortraitSrc(selectedCharacterId.value)
  if (selected.value.kind === 'scene' || selected.value.kind === 'blueprint') {
    const summary: CatalogSummary = {
      kind: selected.value.kind,
      id: selected.value.id,
      title: recordTitle(selected.value),
      characterId: selectedCharacterId.value,
      category: typeof selectedDataRecord.value?.category === 'string' ? selectedDataRecord.value.category : '',
      rating: typeof selectedDataRecord.value?.rating === 'string' ? selectedDataRecord.value.rating : '',
      sortOrder: selected.value.sortOrder ?? 0,
      revision: selected.value.revision ?? 0,
      updatedAt: selected.value.updatedAt ?? null,
    }
    return thumbUrl(catalogShowcaseId(summary))
  }
  return ''
})
const selectedPreviewAdult = computed(() => {
  if (!selected.value) return false
  const rawRating = typeof selectedDataRecord.value?.rating === 'string' ? selectedDataRecord.value.rating : ''
  return rawRating === 'R18'
})
function rowSubtitle(item: CatalogSummary) {
  if (item.kind === 'document') return ({ tags: '常用关键词与显示名称', curation: '精选故事与展示顺序', 'tag-dictionary-policy': '让同义词指向正确的内容', 'prompt-pinned-scenes': '已确认的内容，在此查看', loras: '绘图资源，在此查看', 'retired-scenes': '保留已经归档的故事' } as Record<string, string>)[item.id] || '创作资料'
  const role = item.kind !== 'character' ? characterNames.value[item.characterId] : ''
  return [role, catalogCategory(item.category), item.rating === 'R18' ? catalogRating(item.rating) : ''].filter(Boolean).join(' · ') || CATALOG_LABELS[item.kind]
}
function retryHistory(event: MouseEvent) {
  const button = event.currentTarget
  if (button instanceof HTMLButtonElement && document.activeElement === button) button.closest('details')?.querySelector<HTMLElement>(':scope > summary')?.focus({ preventScroll: true })
  void loadHistory()
}
function pendingTitle(change: CatalogChange) {
  if (change.data) return recordTitle({ kind: change.kind, id: change.id, revision: change.expectedRevision, sortOrder: 0, createdAt: null, updatedAt: null, data: change.data })
  return catalogTitle(change.kind, change.id, result.value?.items.find(row => row.kind === change.kind && row.id === change.id)?.title || change.id)
}
async function openContent(item: CatalogSummary, event: MouseEvent) {
  if (selected.value?.revision && !detailLoading.value && selected.value.kind === item.kind && selected.value.id === item.id) {
    await resumeEditor()
    return
  }
  const intent = new AbortController()
  let interrupted = false
  const interrupt = (event: Event) => {
    if (event.target instanceof Element && event.target.closest('[role="alertdialog"]')) return
    interrupted = true
  }
  // Loading can shrink a long editor and clamp scrollY. Only subsequent input
  // indicates that the user has moved on; layout changes must not cancel entry.
  for (const name of ['wheel', 'touchstart', 'pointerdown', 'keydown']) window.addEventListener(name, interrupt, { passive: true, signal: intent.signal })
  try {
    if (!await select(item)) return
    if (interrupted || section.value !== 'records') return
    browsing.value = false
    await nextTick()
    if (compact.value || event.detail === 0) await focusEditor()
    else editorPane.value?.scrollIntoView({ block: 'start', behavior: scrollBehavior() })
  } finally { intent.abort() }
}
async function archiveContent() {
  const source = document.activeElement
  await remove()
  await nextTick()
  if (!selected.value && source && !source.isConnected && document.activeElement === document.body)
    listFilters.value?.focusSearch()
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
async function prepareEdits() {
  if (!dirtyEditor.value) return true
  if (!await switchSection('records')) return false
  browsing.value = false
  await nextTick()
  return stage()
}
async function saveEdits() { if (await prepareEdits()) await submit(false) }
async function addBlueprintFor(characterId: string) {
  if (busy.value || dirty.value || !await switchSection('records')) return
  kind.value = 'blueprint'; character.value = characterId
  if (await add() && selected.value?.kind === 'blueprint') {
    (selected.value.data as Record<string, unknown>).characterId = characterId
    lastOnboardedCharacter.value = ''
    await resumeEditor()
  }
}
function clearFieldError() { fieldError.value = null }
async function reviewEdits() {
  if (!await prepareEdits()) return
  await submit(true)
  await nextTick()
  if (!preview.value) return
  reviewArea.value?.focus({ preventScroll: true })
  reviewArea.value?.scrollIntoView({ block: 'start', behavior: scrollBehavior() })
}
async function checkContent() { checking.value = true; try { await catalogApi.check(); toolHint.value = '检查完成，资料关联完整' } catch (e) { toolHint.value = (e as Error).message } finally { checking.value = false } }
async function listBackups() { checking.value = true; try { const { maintenanceApi } = await import('@/api/maintenanceApi'); backups.value = (await maintenanceApi.listBackups()).entries; toolHint.value = '找到 ' + backups.value.length + ' 份图片备份' } catch (e) { toolHint.value = (e as Error).message } finally { checking.value = false } }
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
  if (busy.value || switchingSection.value) return
  switchingSection.value = true
  try {
    if (artManager.value && !await artManager.value.canLeave()) return
    if (!await changeKind(value)) return
    section.value = 'records'
    browsing.value = true
  } finally { switchingSection.value = false }
}
function navigateTo(value: string) {
  const entry = kinds.find(item => item.value === value)
  if (entry) void switchKind(entry.value)
  else void switchSection(value)
}
async function readBulkFile(event: Event) { const file = (event.target as HTMLInputElement).files?.[0]; if (file) await readBulkSource(file) }
onMounted(() => {
  if (route.query.tab === 'portraits') section.value = 'portraits'
  if (typeof route.query.created === 'string') {
    const id = route.query.created
    kind.value = /^sc\d+$/.test(id) ? 'scene' : 'blueprint'
    search.value = id
    void select({ kind: kind.value, id }).then(opened => { if (opened) browsing.value = false })
  }
})
</script>
