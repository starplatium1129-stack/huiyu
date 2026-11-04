<template>
  <div class="panel step-panel advanced-decision expert-tag-panel" id="stepTags">
    <section class="tag-browser" :aria-label="isOutfitLibrary ? '搜索与选择服装' : '搜索与选择词条'">
      <div class="tag-dictionary-heading">
        <strong v-if="isOutfitLibrary">服装库</strong>
        <strong v-else>{{ gelbooruDictionary ? 'Gelbooru 词库' : '本地词条' }}<small v-if="gelbooruDictionary" class="expert-tag-count">已核验 {{ verifiedTagCount }} 条</small></strong>
        <a v-if="!isOutfitLibrary && usesTagSyntax" class="tag-dictionary-link" href="https://gelbooru.com/index.php?page=tags&amp;s=list" target="_blank" rel="noopener noreferrer" aria-label="打开 Gelbooru 词典，在新窗口打开"><ArchiveIcon name="search" />Gelbooru 查词</a>
      </div>
      <p v-if="!isOutfitLibrary && isAnima" class="tag-dictionary-note">普通词条优先 Gelbooru；画师名沿用 Danbooru。</p>
      <p v-else-if="!isOutfitLibrary && isMoss" class="tag-dictionary-note">MOSS 使用词条＋自然语言：词条控制画面元素，描述补充动作与空间关系。括号权重不生效。</p>
      <p v-else-if="!isOutfitLibrary && promptFormat === 'natural-language'" class="tag-dictionary-note">词条用于组织画面，最终以自然语言发送。</p>
      <div class="tag-search-row">
        <StudioSearch v-model="tagSearch" class="tag-search" :label="isOutfitLibrary ? '搜索服装' : '搜索词条'"
          :placeholder="isOutfitLibrary ? '搜索服装、角色或词条…' : '搜索中文含义、英文词条或别名…'" />
        <button class="btn btn-quiet btn-sm" type="button" aria-controls="manual-tag-entry" @click="focusTagInput">自选词条</button>
      </div>
      <div class="tag-categories studio-segments studio-segments--compact" data-fluid-glass role="group" aria-label="词条与服装分类">
        <AnimatedSelection />
        <button v-for="cat in tagCategories" :key="cat.id" type="button" :aria-pressed="tagCategory === cat.id" @click="tagCategory = cat.id">{{ cat.label }}</button>
      </div>
      <DirectorOutfitLibrary v-if="isOutfitLibrary" v-content-motion:right :search="tagSearch" :tags="clothingTags"
        :tag-meaning="tagMeaning" :tag-description="tagDescription" :display-tag="displayTag" />
      <div v-else ref="tagResults" v-content-motion:right="tagCategory" class="tag-results">
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
        <div v-if="hiddenTagCount" :key="visibleTags.length" ref="tagLoadSentinel" class="workbench-load-sentinel" aria-hidden="true"></div>
        <div v-if="!visibleTags.length" class="tag-results-empty" role="status">
          <span>没有匹配的词条，试试其他关键词或分类。</span>
          <button v-if="tagSearch || tagCategory !== 'all'" class="btn btn-ghost btn-sm tw:mt-s-2" type="button" @click="tagSearch = ''; tagCategory = 'all'">重置词条筛选</button>
        </div>
      </div>
      <div v-if="!isOutfitLibrary && matchedTags.length" class="tag-more-hint">
        <span>已显示 {{ visibleTags.length }} / {{ matchedTags.length }} 个词条</span>
        <button v-if="matchedTags.length > TAG_RENDER_LIMIT" class="btn btn-quiet btn-sm" type="button"
          :aria-disabled="!hiddenTagCount" @click="tagLimit += hiddenTagCount ? TAG_RENDER_LIMIT : 0">{{ hiddenTagCount ? '显示更多' : '已显示全部' }}</button>
      </div>
    </section>
    <section class="tag-editor" aria-label="自选词条">
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
        <span class="manual-tag" :data-weight-tier="isMoss ? 'normal' : tagWeightTier(tag)">
          <span class="manual-tag-text">
            <span class="manual-tag-en">{{ displayTag(tag) }}</span>
            <span v-if="tagLabel(tag)" class="manual-tag-cn">{{ tagLabel(tag) }}</span>
            <span v-if="isSuppressed(tag)" class="manual-tag-cn">暂不生效</span>
          </span>
          <button type="button" class="btn btn-quiet btn-sm btn-icon" :aria-label="'移除词条 ' + tag" @click="removeTag(tag, $event)"><ArchiveIcon name="close" /></button>
        </span>
      </StudioTooltip>
    </div>
    <p v-if="pb.isPopular" class="popular-tags-note">热门角色不加载宁宁/夏目 LoRA 控制词；词库中的词条可用于专家模式微调。</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useIntersectionObserver } from '@vueuse/core'
import { createPromptTagMatcher, type PromptTagEntry, type PromptTagSource } from '@/utils/promptTagDictionary'
import { formatPromptForEngine, type DrawCapabilities, type ModelProfile } from '@/utils/promptPolicy'
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import { usePromptTagTools } from '@/composables/prompt/usePromptTagTools'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import StudioSearch from '@/components/ui/StudioSearch.vue'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import DirectorOutfitLibrary from '@/components/director/DirectorOutfitLibrary.vue'
import { confirmAction } from '@/composables/useConfirm'
import {
  R18_CONTROLS,
  TAG_CATEGORY_LABELS,
  NON_MANUAL_TAGS,
  normalizeCatalogKey,
} from '@/composables/scene/useDirectorCatalog'
import '@/assets/css/director/components/DirectorTagWorkbench.css'

type TagEntry = PromptTagSource

const pb = usePromptBuilderStore()
const props = defineProps<{ promptFormat: DrawCapabilities['promptFormat'] | 'moss-hybrid'; modelProfile: ModelProfile | null }>()
const isAnima = computed(() => props.promptFormat === 'anima-tags')
const isMoss = computed(() => props.promptFormat === 'moss-hybrid')
const usesTagSyntax = computed(() => isAnima.value || isMoss.value)
// Format only the visible label. Selection keeps the catalogue key; site-specific
// synonym changes require evidence and never rewrite exact LoRA control tokens.
function displayTag(tag: string): string {
  if (isMoss.value) return tag.replace(/^\((.*):\s*-?\d+(?:\.\d+)?\)$/, '$1').replace(/_/g, ' ')
  return isAnima.value ? formatPromptForEngine(tag, 'anima', props.modelProfile?.exact_tokens || [], props.modelProfile?.exact_prefixes || []) : tag
}
const { tagMeaning, tagLabel, tagWeightTier, addTag } = usePromptTagTools(pb)
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
    if (isMoss.value && tag.source === 'huiyu/lora') continue
    if (matches({ en: tag.canonicalTag, cn: tag.zhLabel, cat: tag.category, aliases: tag.aliases })) suggestions.push(tag)
    if (suggestions.length === 12) break
  }
  return suggestions
})
const tagCategory = ref('all')
const isOutfitLibrary = computed(() => tagCategory.value === 'Clothing')

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
  .filter(tag => tag.cat !== 'Quality' && !NON_MANUAL_TAGS.has(normalizeCatalogKey(tag.en))
    && (!isMoss.value || tag.source !== 'huiyu/lora'))
  .map(tag => [tag.en, tag])).values()])

const r18Tags = new Set<string>(R18_CONTROLS.map(control => control.tag))
const categoryForTag = (tag: TagEntry) => r18Tags.has(tag.en) ? 'Mature' : tag.cat === 'Official Outfit' ? 'Clothing' : tag.cat
const clothingTags = computed(() => tagCatalog.value.filter(tag => categoryForTag(tag) === 'Clothing'))
const categoryOrder = ['Character', 'Clothing', 'Action', 'Emotion', 'Scene', 'Lighting', 'Appearance', 'Body', 'Camera', 'Style', 'Mature']
const tagCategories = computed(() => {
  const found = new Set(tagCatalog.value.map(categoryForTag).filter(Boolean))
  found.add('Clothing')
  const ordered = categoryOrder.filter(id => found.delete(id))
  return ['all', ...ordered, ...found].map(id => ({ id, label: id === 'all' ? '全部词条' : TAG_CATEGORY_LABELS[id] || id }))
})

/** 一次最多渲染多少条：目录基数远大于此，硬截断必须如实告知（见 hiddenTagCount）。 */
const TAG_RENDER_LIMIT = 72
const tagLimit = ref(TAG_RENDER_LIMIT)
const tagResults = ref<HTMLElement | null>(null)
watch([tagSearch, tagCategory], () => {
  tagLimit.value = TAG_RENDER_LIMIT
  if (tagResults.value) tagResults.value.scrollTop = 0
})

const matchedTags = computed(() => {
  const q = tagSearch.value.trim(), matches = createPromptTagMatcher(q)
  return tagCatalog.value.filter(tag => (tagCategory.value === 'all' || categoryForTag(tag) === tagCategory.value)
    && (!q || matches(tag, tagMeaning(tag.en, tag.cn))))
})

const visibleTags = computed(() => {
  // Selection changes only reorder the visible slice; they never repeat the search.
  const selected: TagEntry[] = [], others: TagEntry[] = []
  for (const tag of matchedTags.value) {
    if (pb.manualTags.has(tag.en)) selected.push(tag)
    else if (others.length < tagLimit.value) others.push(tag)
    if (selected.length === tagLimit.value) break
  }
  return [...selected, ...others].slice(0, tagLimit.value)
})

/** The rest remains reachable through the incremental display control. */
const hiddenTagCount = computed(() => Math.max(0, matchedTags.value.length - visibleTags.value.length))
const tagLoadSentinel = ref<HTMLElement | null>(null)
useIntersectionObserver(tagLoadSentinel, entries => {
  if (entries.some(entry => entry.target === tagLoadSentinel.value && entry.isIntersecting) && hiddenTagCount.value) tagLimit.value += TAG_RENDER_LIMIT
}, { rootMargin: '160px 0px' })

const suppressedKeys = computed(() => new Set((pb.outfitOverride?.suppressedTags || []).map(pb.tagDictionary.canonicalize)))
const isSuppressed = (tag: string) => suppressedKeys.value.has(pb.tagDictionary.canonicalize(tag))
</script>
