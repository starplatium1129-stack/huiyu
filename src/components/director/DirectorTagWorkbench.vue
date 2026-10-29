<template>
  <div class="panel step-panel advanced-decision expert-tag-panel" id="stepTags">
    <section class="tag-browser" aria-label="搜索与选择词条">
      <div class="tag-dictionary-heading">
        <strong>{{ gelbooruDictionary ? 'Gelbooru 词库' : '本地词条' }}<small v-if="gelbooruDictionary" class="expert-tag-count">已核验 {{ verifiedTagCount }} 条</small></strong>
        <a v-if="isAnima" class="tag-dictionary-link" href="https://gelbooru.com/index.php?page=tags&amp;s=list" target="_blank" rel="noopener noreferrer" aria-label="打开 Gelbooru 词典，在新窗口打开"><ArchiveIcon name="search" />Gelbooru 查词</a>
      </div>
      <p v-if="isAnima" class="tag-dictionary-note">普通词条优先 Gelbooru；画师名沿用 Danbooru。</p>
      <p v-else-if="promptFormat === 'natural-language'" class="tag-dictionary-note">词条用于组织画面，最终以自然语言发送。</p>
      <div class="tag-search-row">
        <StudioSearch v-model="tagSearch" class="tag-search" label="搜索词条" placeholder="搜索中文含义、英文词条或别名…" />
        <button class="btn btn-quiet btn-sm" type="button" aria-controls="manual-tag-entry" @click="focusTagInput">自选词条</button>
      </div>
      <div class="tag-categories studio-segments studio-segments--compact" data-fluid-glass role="group" aria-label="词条分类">
        <AnimatedSelection />
        <button v-for="cat in tagCategories" :key="cat.id" type="button"
          :aria-pressed="tagCategory === cat.id"
          @click="tagCategory = cat.id">{{ cat.label }}</button>
      </div>
      <div v-content-motion:right="tagCategory" class="tag-results">
        <StudioTooltip v-for="tag in visibleTags" :key="tag.en" :content="tagDescription(tag)">
          <button
            type="button"
            :class="{ selected: pb.manualTags.has(tag.en) }"
            :aria-pressed="pb.manualTags.has(tag.en)"
            @click="pb.toggleManualTag(tag.en)">
            <ArchiveIcon name="success" class="tag-option-check" />
            <strong>{{ tagMeaning(tag.en, tag.cn) }}</strong><small>{{ displayTag(tag.en) }}</small>
          </button>
        </StudioTooltip>
        <div v-if="!visibleTags.length" class="tag-results-empty" role="status">
          <span>没有匹配的词条，试试其他关键词或分类。</span>
          <button v-if="tagSearch || tagCategory !== 'all'" class="btn btn-ghost btn-sm tw:mt-s-2" type="button" @click="tagSearch = ''; tagCategory = 'all'">重置词条筛选</button>
        </div>
      </div>
      <p v-if="hiddenTagCount" class="tag-more-hint">
        另有 {{ hiddenTagCount }} 个匹配词条未展示；可细化搜索，或在「自选词条」中粘贴添加。
      </p>
    </section>
    <section class="tag-editor" aria-label="自选词条与衣橱">
    <div class="tag-editor-entry">
    <div class="panel-title expert-tags-header">
      <label for="manual-tag-entry">自选词条 <small class="expert-tag-count" v-if="pb.manualTags.size">已选 {{ pb.manualTags.size }} 个</small></label>
      <div v-if="pb.manualTags.size" class="expert-tags-actions">
        <button type="button" class="btn btn-quiet btn-sm clear-tags-btn" @click="clearTags">清空词条</button>
      </div>
    </div>
    <input id="manual-tag-entry" ref="tagInput" v-model="tagInputText" class="tag-input" type="text" aria-label="添加词条" list="prompt-tag-suggestions" placeholder="输入或批量粘贴词条，按回车添加…"
      spellcheck="false" autocorrect="off" autocapitalize="off"
      @keydown.enter="onTagEnter" />
    <small class="tag-entry-hint">支持逗号、顿号或换行分隔，按回车添加。</small>
    <datalist id="prompt-tag-suggestions">
      <option v-for="tag in inputSuggestions" :key="tag.canonicalTag" :value="displayTag(tag.canonicalTag)" :label="[tag.zhLabel, ...tag.aliases].filter(Boolean).join(' · ')" />
    </datalist>
    </div>
    <div v-if="pb.manualTags.size" class="manual-tags">
      <StudioTooltip v-for="tag in pb.manualTags" :key="tag" :content="tagMeaning(tag)">
        <span class="manual-tag" :data-weight-tier="tagWeightTier(tag)">
          <span class="manual-tag-text">
            <span class="manual-tag-en">{{ displayTag(tag) }}</span>
            <span v-if="tagLabel(tag)" class="manual-tag-cn">{{ tagLabel(tag) }}</span>
          </span>
          <button type="button" class="btn btn-quiet btn-sm btn-icon" :aria-label="'移除词条 ' + tag" @click="removeTag(tag, $event)"><ArchiveIcon name="close" /></button>
        </span>
      </StudioTooltip>
    </div>
    <!-- 全角色通用·特典衣橱预设（无论工作室角色还是热门角色均可一键套用） -->
    <details class="outfit-presets" aria-label="全角色通用·特典衣橱" @toggle="($event.target as HTMLDetailsElement).open && (universalRevealed = true)">
      <StudioDisclosureSummary class="wardrobe-summary">
        <span class="wardrobe-summary-copy">
          <strong><ArchiveIcon name="wardrobe" /> 通用衣橱</strong>
          <span class="wardrobe-selection" :class="{ 'has-selection': selectedUniversalLabels.length }">{{ universalWardrobePresets.length }} 套 · {{ selectedUniversalLabels.length ? '已选：' + selectedUniversalLabels.join('、') : '跨角色换装' }}</span>
        </span>
        <span class="wardrobe-toggle">
          <span class="wardrobe-expand">展开</span><span class="wardrobe-collapse">收起</span>
        </span>
      </StudioDisclosureSummary>
      <div data-disclosure-content>
      <template v-if="universalRevealed">
      <p class="wardrobe-description">一键跨角色换装（露背毛衣 / 兔女郎 / 系带水着 / 圣诞装等），带自动防冲突</p>
      <div class="outfit-preset-list universal-preset-list">
        <StudioTooltip v-for="preset in universalWardrobePresets" :key="preset.id" :content="preset.description">
          <button
            type="button" class="outfit-preset"
            :class="{ selected: isPresetActive(preset.tags) }"
            :aria-pressed="isPresetActive(preset.tags)"
            @click="toggleUniversalPreset(preset.tags, preset.label)">
            <ArchiveIcon name="success" class="tag-option-check" />
            <strong>{{ preset.label }}</strong>
            <small>{{ preset.description }}</small>
          </button>
        </StudioTooltip>
      </div>
      </template>
      </div>
    </details>

    <details v-if="!pb.isPopular && visibleOutfitBundles.length" class="outfit-presets" aria-label="专属角色服装词包" @toggle="($event.target as HTMLDetailsElement).open && (outfitsRevealed = true)">
      <StudioDisclosureSummary class="wardrobe-summary">
        <span class="wardrobe-summary-copy">
          <strong><ArchiveIcon name="wardrobe" /> {{ outfitCharacters }} · 服装词包</strong>
          <span class="wardrobe-selection" :class="{ 'has-selection': selectedOutfitLabels.length }">{{ visibleOutfitBundles.length }} 套 · {{ selectedOutfitLabels.length ? '已选：' + selectedOutfitLabels.join('、') : '角色专属，一键装配' }}</span>
        </span>
        <span class="wardrobe-toggle">
          <span class="wardrobe-expand">展开</span><span class="wardrobe-collapse">收起</span>
        </span>
      </StudioDisclosureSummary>
      <div data-disclosure-content>
      <template v-if="outfitsRevealed">
      <div class="outfit-preset-list">
        <button v-for="bundle in visibleOutfitBundles" :key="bundle.id"
          type="button" class="outfit-preset"
          :class="{ selected: isPresetActive(bundle.tags) }"
          :aria-pressed="isPresetActive(bundle.tags)"
          @click="toggleOutfitBundle(bundle.tags)">
          <ArchiveIcon name="success" class="tag-option-check" />
          <strong>{{ bundle.label }}</strong>
          <small>{{ bundle.tags.slice(0, 4).map(displayTag).join(', ') }}{{ bundle.tags.length > 4 ? ' …' : '' }}</small>
        </button>
      </div>
      <div class="r18-controls" aria-label="成人场景词条">
        <div class="r18-controls-head">
          <strong>成人场景词条</strong>
          <span>角色专属，按需添加</span>
        </div>
        <div class="outfit-preset-list">
        <button v-for="control in visibleR18Controls" :key="control.tag"
          type="button" class="outfit-preset"
          :class="{ selected: pb.manualTags.has(control.tag) }"
          :aria-pressed="pb.manualTags.has(control.tag)"
          @click="pb.toggleManualTag(control.tag)">
          <ArchiveIcon name="success" class="tag-option-check" />
          <strong>{{ control.label }}</strong>
          <small>{{ control.tag }}</small>
        </button>
        </div>
      </div>
      </template>
      </div>
    </details>
    <p v-if="pb.isPopular" class="popular-tags-note">热门角色不加载宁宁/夏目 LoRA 控制词；词库中的词条可用于专家模式微调。</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { createPromptTagMatcher, type PromptTagEntry, type PromptTagSource } from '@/utils/promptTagDictionary'
import { formatPromptForEngine, type DrawCapabilities, type ModelProfile } from '@/utils/promptPolicy'
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import { usePromptTagTools } from '@/composables/prompt/usePromptTagTools'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import StudioSearch from '@/components/ui/StudioSearch.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import { confirmAction } from '@/composables/useConfirm'
import {
  OUTFIT_BUNDLES,
  R18_CONTROLS,
  TAG_CATEGORY_LABELS,
  NON_MANUAL_TAGS,
  normalizeCatalogKey,
} from '@/composables/scene/useDirectorCatalog'
import { UNIVERSAL_WARDROBE_PRESETS } from '@/config/universalWardrobe'
import '@/assets/css/director/components/DirectorTagWorkbench.css'

type TagEntry = PromptTagSource

const pb = usePromptBuilderStore()
const props = defineProps<{ promptFormat: DrawCapabilities['promptFormat']; modelProfile: ModelProfile | null }>()
const isAnima = computed(() => props.promptFormat === 'anima-tags')
// Format only the visible label. Selection keeps the catalogue key; site-specific
// synonym changes require evidence and never rewrite exact LoRA control tokens.
function displayTag(tag: string): string {
  return isAnima.value ? formatPromptForEngine(tag, 'anima', props.modelProfile?.exact_tokens || [], props.modelProfile?.exact_prefixes || []) : tag
}
const { tagMeaning, tagLabel, tagWeightTier, toggleOutfitBundle, addTag } = usePromptTagTools(pb)
const verifiedTagCount = computed(() => pb.tags.filter(tag => tag.source === 'gelbooru' && tag.verification?.canonicalTag === tag.en).length)
const gelbooruDictionary = computed(() => verifiedTagCount.value > 0 && pb.tags.every(tag =>
  tag.source === 'huiyu/lora' || tag.source === 'gelbooru' && tag.verification?.canonicalTag === tag.en))
function tagDescription(tag: TagEntry): string {
  const meaning = tagMeaning(tag.en, tag.cn)
  return tag.source === 'gelbooru' && tag.verification?.canonicalTag === tag.en
    ? `${meaning}\nGelbooru · ${tag.verification.canonicalTag} · ${tag.verification.checkedAt.slice(0, 10)}`
    : tag.source === 'huiyu/lora' ? `${meaning}\n项目 LoRA 控制词` : meaning
}

const tagSearch = ref('')
// Keep native disclosure shells and their live selection summaries from the start.
const universalRevealed = ref(false), outfitsRevealed = ref(false)
const tagInputText = ref('')
const tagInput = ref<HTMLInputElement | null>(null)
function focusTagInput() {
  const input = tagInput.value
  const editor = input?.closest<HTMLElement>('.tag-editor'), body = input?.closest<HTMLElement>('.prompt-workbench-body')
  if (!input || !editor || !body) return
  input.focus({ preventScroll: true })
  const container = /auto|scroll/.test(getComputedStyle(editor).overflowY) ? editor : body
  const entry = editor.querySelector<HTMLElement>('.tag-editor-entry') || input
  const bounds = container.getBoundingClientRect(), target = entry.getBoundingClientRect()
  const padding = parseFloat(getComputedStyle(container).scrollPaddingTop) || 0
  const top = bounds.top + container.clientTop + padding, bottom = bounds.top + container.clientTop + container.clientHeight - padding
  const delta = target.top < top ? target.top - top : Math.max(0, target.bottom - bottom)
  if (delta) container.scrollBy({ top: delta, behavior: 'instant' })
}
function removeTag(tag: string, event: MouseEvent) {
  if (event.currentTarget === document.activeElement) focusTagInput()
  pb.toggleManualTag(tag)
}
const inputSuggestions = computed(() => {
  const query = tagInputText.value.trim(), suggestions: PromptTagEntry[] = []
  if (!query || /[,，、\r\n]/.test(tagInputText.value)) return suggestions
  const matches = createPromptTagMatcher(query)
  for (const tag of pb.tagDictionary.entries) {
    if (matches({ en: tag.canonicalTag, cn: tag.zhLabel, cat: tag.category, aliases: tag.aliases })) suggestions.push(tag)
    if (suggestions.length === 12) break
  }
  return suggestions
})
const tagCategory = ref('all')

function onTagEnter(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  addTag(event)
  tagInputText.value = ''
}

/**
 * 清空全部手工词条（2026-08-30 UX 审计 P0-4）。
 * 原先是模板里直接 `@click="pb.manualTags = new Set()"` —— 一点即没。手工挑的、
 * 反推得来的词条是本项目最高成本的手工资产，而同一产品的「清空并重来」
 * （PromptBuilderView）却是有确认的，两种策略并存。这里统一走破坏性确认。
 */
async function clearTags() {
  const count = pb.manualTags.size
  if (!count) return
  const ok = await confirmAction({
    title: `清空已激活的 ${count} 个词条？`,
    message: '将移除当前全部自选词条与反推标签，此操作无法撤销。',
    confirmLabel: '清空词条',
    danger: true,
  })
  if (!ok) return
  pb.manualTags = new Set()
  pb.flash('已清空词条')
}

// The catalog is the only vocabulary authority, including registered LoRA
// controls. Preset contents and scene prose cannot silently expand the dictionary.
const tagCatalog = computed<TagEntry[]>(() => [...new Map(pb.tags
  .filter(tag => tag.cat !== 'Quality' && !NON_MANUAL_TAGS.has(normalizeCatalogKey(tag.en)))
  .map(tag => [tag.en, tag])).values()])

const tagCategories = computed(() => {
  const found = new Set(tagCatalog.value.map(tag => tag.cat).filter(Boolean))
  return ['all', ...found].map(id => ({ id, label: TAG_CATEGORY_LABELS[id] || id }))
})

/** 一次最多渲染多少条：目录基数远大于此，硬截断必须如实告知（见 hiddenTagCount）。 */
const TAG_RENDER_LIMIT = 72

const matchedTags = computed(() => {
  const q = tagSearch.value.trim(), matches = createPromptTagMatcher(q)
  return tagCatalog.value.filter(tag => (tagCategory.value === 'all' || tag.cat === tagCategory.value)
    && (!q || matches(tag, tagMeaning(tag.en, tag.cn))))
})

const visibleTags = computed(() => {
  // Selection changes only reorder the visible slice; they never repeat the search.
  const selected: TagEntry[] = [], others: TagEntry[] = []
  for (const tag of matchedTags.value) {
    if (pb.manualTags.has(tag.en)) selected.push(tag)
    else if (others.length < TAG_RENDER_LIMIT) others.push(tag)
    if (selected.length === TAG_RENDER_LIMIT) break
  }
  return [...selected, ...others].slice(0, TAG_RENDER_LIMIT)
})

/**
 * 被截断的条数（2026-08-30 UX 审计）。
 *
 * 目录基数远超 72，而这里长期静默截断——用户搜「dress」看到几十条就到底了，
 * 会以为「库里只有这些」，从而放弃用更准的词。现在把「还有多少条没显示」
 * 说出来，并提示继续输入以缩小范围。
 */
const hiddenTagCount = computed(() => Math.max(0, matchedTags.value.length - visibleTags.value.length))

const visibleOutfitBundles = computed(() =>
  OUTFIT_BUNDLES.filter(bundle => pb.char === 'triad' || bundle.character === pb.char),
)

const universalWardrobePresets = computed(() => UNIVERSAL_WARDROBE_PRESETS)
const outfitCharacters = computed(() => [...new Set(visibleOutfitBundles.value.map(bundle => bundle.label.split(' · ')[0]))].join(' / '))
const selectedOutfitLabels = computed(() => visibleOutfitBundles.value.filter(bundle => isPresetActive(bundle.tags)).map(bundle => bundle.label))
const selectedUniversalLabels = computed(() => universalWardrobePresets.value.filter(preset => isPresetActive(preset.tags)).map(preset => preset.label))

function isPresetActive(tags: string[]): boolean {
  if (!tags.length) return false
  const canonical = tags.map(pb.tagDictionary.canonicalize)
  if (pb.isPopular && pb.outfitOverride) {
    const set = new Set(pb.outfitOverride.tokens.map(pb.tagDictionary.canonicalize))
    return canonical.every(t => set.has(t))
  }
  return canonical.every(t => pb.manualTags.has(t))
}

function toggleUniversalPreset(tags: string[], label: string) {
  if (isPresetActive(tags)) {
    if (pb.isPopular) {
      pb.clearOutfitOverride()
    } else {
      toggleOutfitBundle(tags)
    }
    pb.flash(`已卸下「${label}」`)
    return
  }
  if (pb.isPopular) {
    pb.setOutfitOverride(tags, label)
    pb.flash(`已为当前热门角色换装「${label}」`)
  } else {
    toggleOutfitBundle(tags)
    pb.flash(`已装配「${label}」`)
  }
}

const visibleR18Controls = computed(() =>
  R18_CONTROLS.filter(control => pb.char === 'triad' || control.character === pb.char),
)
</script>
