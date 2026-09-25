<template>
  <details class="artist-style-picker advanced-decision" data-testid="artist-style-picker">
    <summary>
      <div class="artist-summary-title">
        <span>画师风格</span>
        <small v-if="selected.length" class="artist-active-pill">已启用 {{ selected.length }}/2</small>
      </div>
      <div class="artist-summary-right">
        <strong :class="{ active: selected.length }">{{ selectionSummary }}</strong>
        <StudioTooltip v-if="selected.length" content="清空画师风格">
          <button
            type="button"
            class="artist-clear-inline"
            @click.stop="clearSelected"
          >
            清空
          </button>
        </StudioTooltip>
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
          <StudioTooltip
            v-for="combo in ARTIST_COMBO_PRESETS"
            :key="combo.id"
            :content="`${combo.tagline} · ${combo.mood}`"
          >
            <button
              type="button"
              class="artist-combo-btn"
              :class="{ active: isComboActive(combo.artistIds) }"
              @click="applyCombo(combo.artistIds)"
            >
              <div class="combo-top">
                <ArchiveIcon :name="combo.icon || 'spark'" class="combo-icon" />
                <span class="combo-label">{{ combo.label }}</span>
              </div>
              <small class="combo-tagline">{{ combo.tagline }}</small>
            </button>
          </StudioTooltip>
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
            <StudioTooltip v-if="frequentTop3Ids.includes(option.id)" content="常用画师：使用频次 Top 3 自动置顶">
              <small class="artist-frequent">
                <ArchiveIcon name="flame" class="badge-icon" />
                <span>常用</span>
              </small>
            </StudioTooltip>
            <StudioTooltip v-else-if="props.curatedArtistStyles?.includes(option.id)" content="角色专属：官方原画师或精选推荐画风">
              <small class="artist-curated">
                <ArchiveIcon name="spark" class="badge-icon" />
                <span>推荐</span>
              </small>
            </StudioTooltip>
            <small v-else class="artist-style-status" :class="option.verification">{{ verificationLabel(option.verification) }}</small>
          </span>
          <small class="artist-desc">{{ option.description }}</small>
          <StudioTooltip v-if="option.masterpiece" :content="option.masterpiece">
            <small class="artist-masterpiece">
              <span class="masterpiece-badge">代表作</span>
              <span class="masterpiece-text">{{ option.masterpiece }}</span>
            </small>
          </StudioTooltip>
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
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
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

<style scoped src="@/assets/css/artist-style-picker.css"></style>
