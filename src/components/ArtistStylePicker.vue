<template>
  <details class="artist-style-picker advanced-decision" data-testid="artist-style-picker">
    <summary>
      <div class="artist-summary-title">
        <span>画师风格</span>
        <small v-if="selected.length" class="artist-active-pill">已启用 {{ selected.length }}/2</small>
      </div>
      <div class="artist-summary-right">
        <strong :class="{ active: selected.length }">{{ selectionSummary }}</strong>
        <button
          v-if="selected.length"
          type="button"
          class="artist-clear-inline"
          title="清空画师风格"
          @click.stop="clearSelected"
        >
          清空
        </button>
      </div>
    </summary>
    <div class="artist-style-body">
      <!--
        达上限提示（2026-08-30 UX 审计）：超上限时点选原本是静默丢弃，用户会
        以为按钮坏了。role=status 让读屏也能听到原因。
      -->
      <p v-if="limitHint" class="artist-limit-hint" role="status">{{ limitHint }}</p>
      <!-- 灵感混搭黄金预设：一键应用顶级画师组合 -->
      <div class="artist-presets-section">
        <div class="artist-presets-head">
          <span class="artist-presets-head-title">
            <ArchiveIcon name="spark" class="artist-header-icon" />
            <span>灵感画风混搭预设（一键应用）</span>
          </span>
        </div>
        <div class="artist-presets-row">
          <button
            v-for="combo in ARTIST_COMBO_PRESETS"
            :key="combo.id"
            type="button"
            class="artist-combo-btn"
            :class="{ active: isComboActive(combo.artistIds) }"
            :title="`${combo.tagline} · ${combo.mood}`"
            @click="applyCombo(combo.artistIds)"
          >
            <div class="combo-top">
              <ArchiveIcon :name="combo.icon || 'spark'" class="combo-icon" />
              <span class="combo-label">{{ combo.label }}</span>
            </div>
            <small class="combo-tagline">{{ combo.tagline }}</small>
          </button>
        </div>
      </div>

      <div class="artist-controls-bar">
        <!-- 分类选项卡 -->
        <div class="artist-category-tabs" role="group" aria-label="画师分类">
          <button
            v-for="cat in ARTIST_CATEGORIES"
            :key="cat.id"
            type="button"
            class="artist-cat-btn"
            :class="{ active: currentCategory === cat.id }"
            @click="currentCategory = cat.id"
          >
            <ArchiveIcon :name="cat.icon" class="cat-icon" />
            <span>{{ cat.label }}</span>
          </button>
        </div>

        <!-- 搜索输入 -->
        <label class="artist-style-search">
          <input
            v-model.trim="query"
            type="search"
            placeholder="搜索画师名、中文名或代表作…"
            aria-label="搜索画师或作品"
            autocomplete="off"
          >
        </label>
      </div>

      <!-- 画师网格 -->
      <div class="artist-style-grid">
        <button
          v-for="option in filteredOptions"
          :key="option.id"
          type="button"
          :data-artist-style-id="option.id"
          :class="{ selected: selected.includes(option.id) }"
          :aria-pressed="selected.includes(option.id)"
          :disabled="!selected.includes(option.id) && selected.length >= 2"
          @click="toggle(option.id)"
        >
          <span class="artist-style-name">
            <strong>
              <span v-if="option.cnName" class="artist-cn-name">{{ option.cnName }}</span>
              <span class="artist-en-name">{{ option.name }}</span>
            </strong>
            <small v-if="frequentTop3Ids.includes(option.id)" class="artist-frequent" title="常用画师：使用频次 Top 3 自动置顶">
              <ArchiveIcon name="flame" class="badge-icon" />
              <span>常用</span>
            </small>
            <small v-else-if="props.curatedArtistStyles?.includes(option.id)" class="artist-curated" title="角色专属：官方原画师或精选推荐画风">
              <ArchiveIcon name="spark" class="badge-icon" />
              <span>推荐</span>
            </small>
            <small v-else class="artist-style-status" :class="option.verification">{{ verificationLabel(option.verification) }}</small>
          </span>
          <small class="artist-desc">{{ option.description }}</small>
          <small v-if="option.masterpiece" class="artist-masterpiece" :title="option.masterpiece">
            <span class="masterpiece-badge">代表作</span>
            <span class="masterpiece-text">{{ option.masterpiece }}</span>
          </small>
        </button>
      </div>

      <p v-if="!filteredOptions.length" class="artist-style-empty">未找到匹配的画师风格，可尝试更换关键词或代表作名称。</p>

      <!-- Token 预览 -->
      <div v-if="modelTokens" class="artist-style-tokens">
        <span class="tokens-engine">{{ engineLabel }} 注入：</span>
        <code>{{ modelTokens }}</code>
      </div>
    </div>
  </details>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import {
  type ArtistStyleEngine,
  type ArtistStyleOption,
  type ArtistStyleVerification,
  ARTIST_COMBO_PRESETS,
  ARTIST_CATEGORIES,
  artistStyleProse,
} from '@/config/artistStyles'
import { ARTIST_STYLE_OPTIONS } from '@/config/artistStyleCatalog'
import { sortByStyleFunnel, useArtistStyleFunnel } from '@/composables/useArtistStyleFunnel'

const props = withDefaults(defineProps<{
  selected: string[]
  engine: ArtistStyleEngine
  curatedArtistStyles?: string[]
}>(), {
  curatedArtistStyles: () => [],
})
const emit = defineEmits<{
  'update:selected': [value: string[]]
  /** 已达上限还要再加一个时触发，由宿主给用户提示（2026-08-30 UX 审计）。 */
  'limit-reached': [max: number]
}>()

/** 画师最多同时选两位：再多画风会互相打架，出图反而四不像。 */
const ARTIST_STYLE_LIMIT = 2

const query = ref('')
const currentCategory = ref<string>('all')
/** 达上限时的就地提示；选满第三位时给出，取消或换选后清除。 */
const limitHint = ref('')

// 三级漏斗排序逻辑（Top3 常用 + 角色专属 + 目录）已收敛至
// @/composables/useArtistStyleFunnel（2026-09-05 单体拆分）。
const { recordUsage, frequentTop3Ids } = useArtistStyleFunnel(ARTIST_STYLE_OPTIONS)

const selectedOptions = computed(() => ARTIST_STYLE_OPTIONS.filter(option => props.selected.includes(option.id)))

const filteredOptions = computed(() => {
  let list = ARTIST_STYLE_OPTIONS
  if (currentCategory.value !== 'all') {
    list = list.filter(option => option.category === currentCategory.value)
  }
  const needle = query.value.toLocaleLowerCase()
  let matched = list
  if (needle) {
    matched = list.filter(option => {
      const haystack = [
        option.name,
        option.id,
        option.cnName || '',
        option.description,
        option.masterpiece || '',
        ...(option.keywords || []),
      ].join(' ').toLocaleLowerCase()
      return haystack.includes(needle)
    })
  }

  return sortByStyleFunnel(matched, frequentTop3Ids.value, props.curatedArtistStyles || [])
})

const selectionSummary = computed(() => {
  if (!selectedOptions.value.length) return '未启用'
  return selectedOptions.value.map(option => option.cnName ? `${option.cnName}` : option.name).join(' + ')
})

const engineLabel = computed(() => props.engine === 'sd' ? 'WAI / Illustrious' : props.engine === 'anima' ? 'Anima' : 'Krea 2')
const modelTokens = computed(() => {
  if (!selectedOptions.value.length) return ''
  if (props.engine === 'krea2') {
    return artistStyleProse(props.selected, 'krea2')
  }
  return selectedOptions.value.map(option => props.engine === 'anima' ? option.animaTag : option.waiTag).join(', ')
})

function verificationLabel(verification: ArtistStyleVerification): string {
  if (verification === 'project') return '项目实测'
  if (verification === 'tag') return '热门推荐'
  return '官方收录'
}

/**
 * 点选一位画师（2026-08-30 UX 审计）。
 *
 * 原先超上限时只是 `.slice(0,2)` 静默丢弃——用户点了第三位毫无反应，会判定
 * 「按钮坏了」反复点击。现在如实告知已达上限，并说明要先取消一位。
 */
function toggle(id: string) {
  const validIds = new Set(ARTIST_STYLE_OPTIONS.map(option => option.id))
  const current = [...new Set(props.selected.filter(value => validIds.has(value)))].slice(0, ARTIST_STYLE_LIMIT)
  if (current.includes(id)) {
    emit('update:selected', current.filter(value => value !== id))
    return
  }
  if (current.length >= ARTIST_STYLE_LIMIT) {
    limitHint.value = `最多同时选 ${ARTIST_STYLE_LIMIT} 位画师，先取消一位再选`
    emit('limit-reached', ARTIST_STYLE_LIMIT)
    return
  }
  recordUsage([id])
  limitHint.value = ''
  emit('update:selected', [...current, id])
}

function clearSelected() {
  emit('update:selected', [])
}

function isComboActive(artistIds: readonly string[]): boolean {
  if (props.selected.length !== artistIds.length) return false
  return artistIds.every(id => props.selected.includes(id))
}

function applyCombo(artistIds: readonly string[]) {
  if (isComboActive(artistIds)) {
    clearSelected()
  } else {
    recordUsage([...artistIds])
    emit('update:selected', [...artistIds])
  }
}
</script>

<style scoped>
.artist-style-picker {
  margin-bottom: var(--s-3);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-lg);
  background: var(--bg-surface);
}
.artist-style-picker summary {
  display: flex;
  flex-wrap: wrap;
  font-size: var(--fs-body-sm);
  line-height: var(--lh-body);
  align-items: center;
  justify-content: space-between;
  gap: var(--s-3);
  padding: var(--s-3) var(--s-4);
  color: var(--text-primary);
  cursor: pointer;
  font-weight: 700;
}
.artist-summary-title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--s-2);
}
.artist-active-pill {
  padding: 1px 7px;
  border-radius: var(--r-pill);
  font-size: var(--fs-label-xs);
  font-weight: 600;
  color: var(--accent);
  background: var(--accent-soft);
}
.artist-summary-right {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  width: 100%;
  align-items: center;
  gap: var(--s-2);
  margin-left: auto;
}
.artist-summary-right strong {
  overflow-wrap: anywhere;
  flex: 1;
  color: var(--text-muted);
  font-size: var(--fs-label);
}
.artist-summary-right strong.active {
  color: var(--accent);
  font-weight: 700;
}
.artist-clear-inline {
  padding: 1px 6px;
  border-radius: var(--r-sm);
  border: 1px solid var(--border-soft);
  background: transparent;
  color: var(--text-muted);
  font-size: var(--fs-label-xs);
  cursor: pointer;
  transition: border-color var(--motion-hover) var(--ease-out), background var(--motion-hover) var(--ease-out), color var(--motion-hover) var(--ease-out);
}
.artist-clear-inline:hover {
  color: var(--danger-text);
  border-color: var(--danger);
}
.artist-style-body {
  padding: 0 var(--s-4) var(--s-4);
}

/* 黄金混搭预设行 */
.artist-presets-section {
  margin-bottom: var(--s-3);
  padding: var(--s-3);
  border-radius: var(--r-md);
  background: color-mix(in srgb, var(--accent-soft) 20%, var(--bg-deep));
  border: 1px solid color-mix(in srgb, var(--accent) 22%, var(--border-soft));
}
.artist-presets-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--s-2);
  font-size: var(--fs-label-xs);
  font-weight: 600;
  color: var(--accent);
}
.artist-presets-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 210px), 1fr));
  gap: var(--s-2);
}
.artist-combo-btn {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: var(--s-2) var(--s-3);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-sm);
  background: var(--bg-deep);
  color: var(--text-secondary);
  cursor: pointer;
  text-align: left;
  transition: border-color var(--motion-hover) var(--ease-out), background var(--motion-hover) var(--ease-out), color var(--motion-hover) var(--ease-out);
}
.artist-combo-btn:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--text-primary);
}
.artist-combo-btn.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
  box-shadow: 0 0 8px color-mix(in srgb, var(--accent) 25%, transparent);
}
.combo-label {
  font-size: var(--fs-label-sm);
  font-weight: 700;
}
.combo-tagline {
  font-size: var(--fs-label-sm);
  color: var(--text-muted);
}

/* 控制栏 */
.artist-controls-bar {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  margin-bottom: var(--s-3);
}
.artist-category-tabs {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  padding-bottom: 2px;
  scrollbar-width: thin;
}
.artist-presets-head-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.artist-header-icon {
  width: 14px;
  height: 14px;
  color: var(--accent);
}
.combo-top {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.combo-icon {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
  color: currentColor;
  opacity: 0.85;
}
.cat-icon {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  color: currentColor;
  opacity: 0.85;
}
.artist-cat-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: 0 0 auto;
  min-height: 28px;
  padding: 0 var(--s-3);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-pill);
  background: var(--bg-deep);
  color: var(--text-muted);
  cursor: pointer;
  font: 600 var(--fs-mono-xs) var(--font-sans);
  transition: border-color var(--motion-hover) var(--ease-out), background var(--motion-hover) var(--ease-out), color var(--motion-hover) var(--ease-out);
}
.artist-cat-btn:hover {
  color: var(--text-primary);
  border-color: var(--accent);
}
.artist-cat-btn.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}
.artist-style-search input {
  width: 100%;
  min-height: 36px;
  padding: 0 var(--s-3);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-md);
  background: var(--bg-deep);
  color: var(--text-primary);
  font-size: var(--fs-label);
}
.artist-style-search input:focus-visible {
  border-color: var(--accent);
  outline: 2px solid color-mix(in srgb, var(--accent) 25%, transparent);
  outline-offset: 1px;
}

/* 画师网格 */
.artist-style-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 210px), 1fr));
  gap: var(--s-2);
  max-height: 360px;
  overflow-y: auto;
  padding-right: 2px;
}
.artist-style-grid button {
  display: grid;
  gap: var(--s-2);
  line-height: var(--lh-body);
  min-width: 0;
  padding: var(--s-2) var(--s-3);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-md);
  background: var(--bg-deep);
  color: var(--text-secondary);
  text-align: left;
  cursor: pointer;
  transition: border-color var(--motion-hover) var(--ease-out), background var(--motion-hover) var(--ease-out), color var(--motion-hover) var(--ease-out);
}
.artist-style-grid button:hover:not(:disabled),
.artist-style-grid button.selected {
  border-color: var(--accent);
  color: var(--text-primary);
}
.artist-style-grid button.selected {
  background: color-mix(in srgb, var(--accent) 12%, var(--bg-deep));
  box-shadow: inset 2px 0 0 var(--accent);
}
.artist-style-grid button:disabled {
  cursor: not-allowed;
  /* 审计修复：禁用态不用 opacity 压字（压后低于 AA），改用禁用令牌 */
  color: var(--text-disabled);
  border-color: var(--border-soft);
}
.artist-style-name {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-2);
}
.artist-style-name strong { display: grid; min-width: 0; gap: var(--s-1); overflow-wrap: anywhere; }
.artist-cn-name {
  font-size: var(--fs-label-sm);
  font-weight: 700;
  margin-right: 4px;
  color: var(--text-primary);
}
.artist-en-name {
  font-size: var(--fs-label-sm);
  color: var(--text-muted);
  font-weight: 500;
}
.artist-desc {
  color: var(--text-muted);
  font-size: var(--fs-label-sm);
  line-height: var(--lh-label);
}
.artist-masterpiece {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--fs-mono-xs, 0.72rem);
  color: var(--text-secondary);
  line-height: var(--lh-label);
  margin-top: 2px;
  overflow: hidden;
}
.masterpiece-badge {
  flex: 0 0 auto;
  font-size: 0.65rem;
  padding: 1px 4px;
  border-radius: var(--r-xs, 4px);
  background: rgba(56, 189, 248, 0.12);
  color: var(--archive-blue);
  font-weight: 600;
  border: 1px solid rgba(56, 189, 248, 0.25);
}
.masterpiece-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.artist-style-status {
  flex: 0 0 auto;
  padding: 1px 5px;
  border-radius: var(--r-pill);
  background: var(--glass-fill);
  font-size: var(--fs-mono-xs);
}
.artist-frequent {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 6px;
  border-radius: var(--r-pill);
  background: color-mix(in srgb, var(--accent) 14%, var(--bg-deep));
  border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border-soft));
  color: var(--accent);
  font-size: var(--fs-mono-xs);
  font-weight: 600;
}
.artist-curated {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 6px;
  border-radius: var(--r-pill);
  background: rgba(245, 158, 11, 0.12);
  border: 1px solid rgba(245, 158, 11, 0.3);
  color: var(--warning-text);
  font-size: var(--fs-mono-xs);
  font-weight: 600;
}
.badge-icon {
  font-size: 0.85em;
  stroke-width: 2.2;
}
.artist-style-status.project {
  color: var(--success);
}
.artist-style-status.tag {
  color: var(--accent);
}
.artist-style-status.curated {
  color: var(--info-text);
}
.artist-style-empty {
  padding: var(--s-4) 0;
  text-align: center;
  color: var(--text-muted);
}
.artist-style-tokens {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--s-2);
  margin-top: var(--s-3);
  padding: var(--s-2) var(--s-3);
  border-radius: var(--r-md);
  background: color-mix(in srgb, var(--bg-deep) 80%, black);
  border: 1px solid var(--border-soft);
  color: var(--text-muted);
  font-size: var(--fs-label-xs);
}
.tokens-engine {
  font-weight: 600;
  color: var(--accent);
  flex: 0 0 auto;
}
.artist-style-tokens code {
  overflow-wrap: anywhere;
  color: var(--text-primary);
  font-family: var(--font-mono);
}

/* 达上限提示：用警告色而非危险色——这是操作被挡下，不是出错 */
.artist-limit-hint {
  margin:0 0 var(--s-2); padding:var(--s-2) var(--s-3);
  border:1px solid color-mix(in srgb,var(--warning) 40%,var(--border-soft));
  border-radius:var(--r-sm);
  background:color-mix(in srgb,var(--warning) 12%,transparent);
  color:var(--warning-text);
  font-size:var(--fs-label-sm); line-height:var(--lh-label);
}

</style>
