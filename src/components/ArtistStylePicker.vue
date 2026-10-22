<template>
  <div class="artist-style-picker basic-visible" data-testid="artist-style-picker">
    <button type="button" class="artist-picker-trigger" data-control-motion aria-haspopup="dialog" :aria-expanded="dialogOpen" @click="openPicker">
      <div class="artist-summary-title">
        <span>画师风格</span>
        <small v-if="selectedItems.length" class="artist-active-pill">已启用 {{ selectedItems.length }}/{{ ARTIST_STYLE_LIMIT }}</small>
      </div>
      <div class="artist-summary-right">
        <strong :class="{ active: selected.length }">{{ selectionSummary }}</strong>
        <ArchiveIcon name="chevron-down" />
      </div>
    </button>
    <Teleport to="body">
    <dialog ref="panel" class="artist-style-panel" :aria-labelledby="titleId" @close="dialogOpen = Boolean(panel?.open)" @cancel.prevent="closePicker" @click="onBackdrop" @keydown="onPickerKeydown">
    <header class="artist-dialog-heading"><h2 :id="titleId">画师风格</h2><button class="btn btn-ghost btn-icon" type="button" aria-label="关闭画师选择" @click="closePicker"><ArchiveIcon name="close" /></button></header>
    <div v-if="revealed" class="artist-style-body">
      <!--
        达上限提示（2026-08-30 UX 审计）：超上限时点选原本是静默丢弃，用户会
        以为按钮坏了。role=status 让读屏也能听到原因。
      -->
      <p v-if="limitHint" class="artist-limit-hint" role="status">{{ limitHint }}</p>
      <!-- 灵感混搭黄金预设：一键应用顶级画师组合 -->
      <details class="artist-presets-section">
        <StudioDisclosureSummary>画风组合</StudioDisclosureSummary>
        <div data-disclosure-content>
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
              data-control-motion
              :aria-pressed="isComboActive(combo.artistIds)"
              @click="applyCombo(combo.artistIds)"
            >
              <div class="combo-top">
                <ArchiveIcon :name="combo.icon || 'spark'" class="combo-icon" />
                <span class="combo-label">{{ combo.label }}</span>
              </div>
              <small class="combo-tagline">{{ combo.tagline }}</small>
              <ArchiveIcon v-if="isComboActive(combo.artistIds)" class="artist-selected-check" name="success" />
            </button>
          </StudioTooltip>
        </div>
        </div>
      </details>

      <div class="artist-controls-bar">
        <div class="artist-scope studio-segments studio-segments--compact" role="group" aria-label="画师范围"><AnimatedSelection /><button v-for="scope in scopes" :key="scope.id" type="button" :aria-pressed="currentScope === scope.id" @click="currentScope = scope.id">{{ scope.label }}</button></div>
        <!-- 分类选项卡 -->
        <div class="artist-category-tabs studio-segments studio-segments--compact" role="group" aria-label="画师分类">
          <AnimatedSelection />
          <button
            v-for="cat in ARTIST_CATEGORIES"
            :key="cat.id"
            type="button"
            class="artist-cat-btn"
            :aria-pressed="currentCategory === cat.id"
            @click="currentCategory = cat.id"
          >
            <ArchiveIcon :name="cat.icon" class="cat-icon" />
            <span>{{ cat.label }}</span>
          </button>
        </div>

        <!-- 搜索输入 -->
        <StudioSearch v-model="query" class="artist-style-search" label="搜索画师或作品" placeholder="搜索画师名、中文名或代表作…" autocomplete="off" autofocus :clear-on-escape="false" />
      </div>

      <!-- 画师网格 -->
      <div v-if="filteredOptions.length" class="artist-style-grid">
        <button
          v-for="option in filteredOptions"
          :key="option.id"
          type="button"
          :data-artist-style-id="option.id"
          data-control-motion
          :aria-pressed="isOptionSelected(option.id)"
          :disabled="!isOptionSelected(option.id) && selectedBaseIds.length >= ARTIST_STYLE_LIMIT"
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
          <ArchiveIcon v-if="isOptionSelected(option.id)" class="artist-selected-check" name="success" />
          <small class="artist-desc">{{ option.description }}</small>
          <StudioTooltip v-if="option.masterpiece" :content="option.masterpiece">
            <small class="artist-masterpiece">
              <span class="masterpiece-badge">代表作</span>
              <span class="masterpiece-text">{{ option.masterpiece }}</span>
            </small>
          </StudioTooltip>
        </button>
      </div>

      <p v-else class="artist-style-empty" role="status">未找到匹配的画师风格，可尝试更换关键词或代表作名称。</p>

      <!-- Token 预览 -->
      <div v-if="modelTokens" class="artist-style-tokens">
        <span class="tokens-engine">{{ engineLabel }} 注入：</span>
        <code>{{ modelTokens }}</code>
      </div>
    </div>
    <footer v-if="revealed" class="artist-dialog-selected">
      <div>
        <span>已选 {{ selectedItems.length }}/{{ ARTIST_STYLE_LIMIT }}</span>
        <div class="artist-selected-chips">
          <div v-for="item in selectedItems" :key="item.id" class="artist-chip-group">
            <button
              type="button"
              class="btn btn-ghost btn-sm artist-chip-label"
              :aria-label="`移除${item.option.cnName || item.option.name}`"
              @click="removeSelected(item.id, $event)"
            >
              {{ item.option.cnName || item.option.name }}
              <ArchiveIcon name="close" />
            </button>
            <button
              type="button"
              class="artist-weight-pill"
              :class="weightClass(item.weight)"
              :title="`当前权重 ${item.weight}，点击切换档位：0.7(辅) → 1.0(标) → 1.15(主)`"
              :aria-label="`${item.option.cnName || item.option.name} 权重 ${item.weight}，点击切换`"
              @click="cycleWeight(item.id)"
            >
              {{ weightLabel(item.weight) }}
            </button>
          </div>
          <span v-if="!selectedItems.length" class="artist-selection-empty">自然画风</span>
        </div>
      </div>
      <button ref="doneButton" class="btn btn-primary" type="button" @click="closePicker">完成</button>
    </footer>
    </dialog>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, useId } from 'vue'
import { isBackdropClick, useFluidDialog } from '@/composables/useFluidDialog'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import StudioSearch from '@/components/ui/StudioSearch.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import {
  type ArtistStyleEngine,
  type ArtistStyleVerification,
  type ArtistStyleOption,
  ARTIST_CATEGORIES,
  DEFAULT_ARTIST_STYLE_LIMIT,
  parseArtistStyleItem,
  serializeArtistStyleItem,
  normalizeArtistStyleIds,
  artistTagsForEngine,
  artistStyleProse,
} from '@/config/artistStyles'
import { ARTIST_COMBO_PRESETS } from '@/config/artistComboPresets'
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

const ARTIST_STYLE_LIMIT = DEFAULT_ARTIST_STYLE_LIMIT

interface SelectedArtistItem {
  id: string
  weight: number
  option: ArtistStyleOption
}

const selectedItems = computed<SelectedArtistItem[]>(() => {
  const optionsMap = new Map(ARTIST_STYLE_OPTIONS.map(opt => [opt.id, opt]))
  const items: SelectedArtistItem[] = []
  for (const raw of props.selected) {
    const parsed = parseArtistStyleItem(raw)
    if (!parsed) continue
    const opt = optionsMap.get(parsed.id)
    if (opt) {
      items.push({ id: parsed.id, weight: parsed.weight, option: opt })
    }
  }
  return items
})

const selectedBaseIds = computed(() => selectedItems.value.map(item => item.id))

function isOptionSelected(id: string): boolean {
  return selectedBaseIds.value.includes(id)
}

const query = ref('')
const currentCategory = ref<string>('all')
const currentScope = ref('all')
const scopes = [{ id: 'all', label: '全部' }, { id: 'frequent', label: '常用' }, { id: 'recent', label: '最近' }]
const panel = ref<HTMLDialogElement | null>(null)
const doneButton = ref<HTMLButtonElement | null>(null)
const dialogOpen = ref(false)
const revealed = ref(false)
const dialogMotion = useFluidDialog(panel)
const titleId = useId()
async function openPicker(event: MouseEvent) {
  const source = event.currentTarget as HTMLElement
  revealed.value = true
  await nextTick()
  if (!source.isConnected) return
  dialogMotion.open(source)
  dialogOpen.value = Boolean(panel.value?.open)
}
function closePicker() { dialogMotion.close(() => { dialogOpen.value = false }) }
function onBackdrop(event: MouseEvent) { if (isBackdropClick(event, panel.value)) closePicker() }
function onPickerKeydown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.key !== 'Escape' || event.isComposing || event.keyCode === 229) return
  event.preventDefault(); event.stopPropagation(); closePicker()
}
/** 达上限时的就地提示；选满时给出，取消或换选后清除。 */
const limitHint = ref('')

// 三级漏斗排序逻辑（Top3 常用 + 角色专属 + 目录）已收敛至
// @/composables/useArtistStyleFunnel（2026-09-05 单体拆分）。
const { recordUsage, frequentTop3Ids, recentIds } = useArtistStyleFunnel(ARTIST_STYLE_OPTIONS)

const searchDocuments = computed(() => new Map(ARTIST_STYLE_OPTIONS.map(option => [option.id, [
  option.name, option.id, option.cnName || '', option.description, option.masterpiece || '', ...(option.keywords || []),
].join(' ').toLocaleLowerCase()])))

const filteredOptions = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase()
  let list = ARTIST_STYLE_OPTIONS
  if (!needle && currentScope.value !== 'all') {
    const ids = currentScope.value === 'frequent' ? frequentTop3Ids.value : recentIds.value
    list = list.filter(option => ids.includes(option.id))
  }
  if (currentCategory.value !== 'all') {
    list = list.filter(option => option.category === currentCategory.value)
  }
  let matched = list
  if (needle) {
    const documents = searchDocuments.value
    matched = list.filter(option => documents.get(option.id)?.includes(needle))
  }

  return sortByStyleFunnel(matched, frequentTop3Ids.value, props.curatedArtistStyles || [])
})

const selectionSummary = computed(() => {
  if (!selectedItems.value.length) return '未启用'
  return selectedItems.value.map(item => {
    const name = item.option.cnName || item.option.name
    return item.weight !== 1 ? `${name}(${item.weight})` : name
  }).join(' + ')
})

const engineLabel = computed(() => props.engine === 'sd' ? 'WAI / Illustrious' : props.engine === 'anima' ? 'Anima' : 'Krea 2')
const modelTokens = computed(() => {
  if (!selectedItems.value.length) return ''
  if (props.engine === 'krea2') {
    return artistStyleProse(props.selected, 'krea2')
  }
  return artistTagsForEngine(props.selected, props.engine).join(', ')
})

function verificationLabel(verification: ArtistStyleVerification): string {
  if (verification === 'project') return '项目实测'
  if (verification === 'tag') return '热门推荐'
  return '官方收录'
}

function removeSelected(id: string, event: MouseEvent) {
  if (document.activeElement === event.currentTarget) doneButton.value?.focus({ preventScroll: true })
  toggle(id)
}

function cycleWeight(id: string) {
  const current = [...selectedItems.value]
  const item = current.find(x => x.id === id)
  if (!item) return
  let nextWeight = 1
  if (item.weight === 1) nextWeight = 1.15
  else if (item.weight >= 1.1) nextWeight = 0.7
  else nextWeight = 1
  const next = current.map(x => x.id === id ? serializeArtistStyleItem(x.id, nextWeight) : serializeArtistStyleItem(x.id, x.weight))
  emit('update:selected', next)
}

function weightClass(weight: number): string {
  if (weight >= 1.1) return 'dominant'
  if (weight <= 0.8) return 'subtle'
  return 'standard'
}

function weightLabel(weight: number): string {
  if (weight >= 1.1) return `${weight} 主`
  if (weight <= 0.8) return `${weight} 辅`
  return `${weight} 标`
}

function toggle(id: string) {
  const current = [...selectedItems.value]
  const existingIdx = current.findIndex(item => item.id === id)
  if (existingIdx >= 0) {
    limitHint.value = ''
    const next = current.filter((_, idx) => idx !== existingIdx)
    emit('update:selected', next.map(item => serializeArtistStyleItem(item.id, item.weight)))
    return
  }
  if (current.length >= ARTIST_STYLE_LIMIT) {
    limitHint.value = `最多同时选 ${ARTIST_STYLE_LIMIT} 位画师，先取消一位再选`
    emit('limit-reached', ARTIST_STYLE_LIMIT)
    return
  }
  recordUsage([id])
  limitHint.value = ''
  const opt = ARTIST_STYLE_OPTIONS.find(o => o.id === id)
  if (!opt) return
  const next = [...current, { id, weight: 1, option: opt }]
  emit('update:selected', next.map(item => serializeArtistStyleItem(item.id, item.weight)))
}

function clearSelected() {
  limitHint.value = ''
  emit('update:selected', [])
}

function isComboActive(artistIds: readonly string[]): boolean {
  const currentNorm = normalizeArtistStyleIds(props.selected).sort()
  const targetNorm = normalizeArtistStyleIds(artistIds).sort()
  if (currentNorm.length !== targetNorm.length) return false
  return currentNorm.every((val, idx) => val === targetNorm[idx])
}

function applyCombo(artistIds: readonly string[]) {
  if (isComboActive(artistIds)) {
    clearSelected()
  } else {
    const baseIds = artistIds.map(parseArtistStyleItem).filter(Boolean).map(x => x!.id)
    recordUsage(baseIds)
    limitHint.value = ''
    emit('update:selected', [...artistIds])
  }
}
</script>

<style scoped src="@/assets/css/artist-style-picker.css"></style>
