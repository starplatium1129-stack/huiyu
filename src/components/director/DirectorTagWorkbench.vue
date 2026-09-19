<template>
  <div class="panel step-panel advanced-decision expert-tag-panel" id="stepTags">
    <div class="panel-title expert-tags-header">
      <span>词条工作台 · Tags <small class="expert-tag-count" v-if="pb.manualTags.size">已激活 {{ pb.manualTags.size }} 个</small></span>
      <div class="expert-tags-actions">
        <button type="button" class="btn btn-ghost btn-xs" :disabled="interrogateBusy" title="上传图片本地反推为 Tag（WD14 真实模型），可切人直出" @click="triggerInterrogatePick">
          <ArchiveIcon name="search" class="search-icon" />{{ interrogateBusy ? '反推中…' : '本地反推' }}
        </button>
        <span v-if="interrogateMeta" class="tag-interrogate-engine" :class="{ 'is-fallback': interrogateMeta.fallback }" :title="interrogateMeta.title">{{ interrogateMeta.label }}</span>
        <button v-if="pb.manualTags.size" type="button" class="btn btn-ghost btn-xs clear-tags-btn" @click="clearTags">清空词条</button>
      </div>
      <input ref="interrogateInputRef" class="sr-only" type="file" accept="image/*" @change="onInterrogateFile" />
    </div>
    <div v-if="interrogateError" class="tag-interrogate-error" role="alert">{{ interrogateError }}</div>
    <div class="manual-tags" :class="{ empty: !pb.manualTags.size }">
      <span v-for="tag in pb.manualTags" :key="tag" class="manual-tag" :data-weight-tier="tagWeightTier(tag)" :title="tagMeaning(tag)">
        <span class="manual-tag-en">{{ tag }}</span>
        <span v-if="tagLabel(tag)" class="manual-tag-cn">{{ tagLabel(tag) }}</span>
        <button type="button" class="tag-remove" :aria-label="'移除词条 ' + tag" @click="pb.toggleManualTag(tag)">×</button>
      </span>
      <p v-if="!pb.manualTags.size" class="manual-tags-empty-hint">
        暂未激活自选词条。可在下方点选预设战袍、装配专属服装包，或搜索与批量输入标签添加。
      </p>
    </div>
    <!-- 全角色通用·特典衣橱预设（无论工作室角色还是热门角色均可一键套用） -->
    <div class="outfit-presets universal-wardrobe-section" aria-label="全角色通用·特典衣橱">
      <div class="outfit-presets-head">
        <strong><ArchiveIcon name="wardrobe" /> 全角色通用 · 特典战袍衣橱</strong>
        <span>一键跨角色换装（露背毛衣 / 兔女郎 / 系带水着 / 圣诞装等），带自动防冲突</span>
      </div>
      <div class="outfit-preset-list universal-preset-list">
        <button v-for="preset in universalWardrobePresets" :key="preset.id"
          type="button" class="outfit-preset universal-outfit-btn"
          :class="{ selected: isPresetActive(preset.tags) }"
          :aria-pressed="isPresetActive(preset.tags)"
          :title="preset.description"
          @click="toggleUniversalPreset(preset.tags, preset.label)">
          <strong>{{ preset.label }}</strong>
          <small>{{ preset.description }}</small>
        </button>
      </div>
    </div>

    <div v-if="!pb.isPopular" class="outfit-presets" aria-label="专属角色服装词包">
      <div class="outfit-presets-head">
        <strong>专属角色服装词包</strong>
        <span>宁宁 / 夏目官方训练词条，一键装配</span>
      </div>
      <div class="outfit-preset-list">
        <button v-for="bundle in visibleOutfitBundles" :key="bundle.id"
          type="button" class="outfit-preset"
          :class="{ selected: bundle.tags.every(tag => pb.manualTags.has(tag)) }"
          :aria-pressed="bundle.tags.every(tag => pb.manualTags.has(tag))"
          @click="toggleOutfitBundle(bundle.tags)">
          <strong>{{ bundle.label }}</strong>
          <small>{{ bundle.tags.slice(0, 4).join(', ') }}{{ bundle.tags.length > 4 ? ' …' : '' }}</small>
        </button>
      </div>
      <div class="r18-controls" aria-label="R18 角色门控词">
        <div class="outfit-presets-head r18-controls-head">
          <strong>R18 角色门控词</strong>
          <span>按角色启用，仅在成人场景中选择</span>
        </div>
        <div class="outfit-preset-list">
        <button v-for="control in visibleR18Controls" :key="control.tag"
          type="button" class="outfit-preset r18-control"
          :class="{ selected: pb.manualTags.has(control.tag) }"
          :aria-pressed="pb.manualTags.has(control.tag)"
          @click="pb.toggleManualTag(control.tag)">
          <strong>{{ control.label }}</strong>
          <small>{{ control.tag }}</small>
        </button>
        </div>
      </div>
    </div>
    <p v-else class="popular-tags-note">热门角色不加载宁宁/夏目 LoRA 控制词；下方词条可直接用于专家模式微调，成人蓝图仅对成年角色可见。</p>
    <div class="tag-browser">
      <input v-model="tagSearch" class="tag-input" type="search" aria-label="搜索词条" placeholder="搜索中文含义或 Danbooru 英文标签…" />
      <div class="tag-categories" role="group" aria-label="词条分类">
        <button v-for="cat in tagCategories" :key="cat.id" type="button"
          :class="{ active: tagCategory === cat.id }"
          :aria-pressed="tagCategory === cat.id"
          @click="tagCategory = cat.id">{{ cat.label }}</button>
      </div>
      <div class="tag-results">
        <button v-for="tag in visibleTags" :key="tag.en" type="button"
          :class="{ selected: pb.manualTags.has(tag.en) }"
          :aria-pressed="pb.manualTags.has(tag.en)"
          :title="tagMeaning(tag.en, tag.cn)"
          @click="pb.toggleManualTag(tag.en)">
          <strong>{{ tagMeaning(tag.en, tag.cn) }}</strong><small>{{ tag.en }}</small>
        </button>
      </div>
      <!--
        截断告知（2026-08-30 UX 审计）：这里长期硬截 72 条且不说明，用户会以为
        「库里只有这些」。提示里给出还能用的手段——继续输入关键词收窄，或直接
        在下方输入框手输（那条路径不经过这里的截断）。
      -->
      <p v-if="hiddenTagCount" class="tag-more-hint">
        还有 {{ hiddenTagCount }} 个匹配词条未展示，可输入更具体的关键词收窄，或在下方直接粘贴添加
      </p>
    </div>
    <input class="tag-input" type="text" placeholder="支持直接输入或批量粘贴标签（逗号/顿号/换行分隔），按回车添加…"
      @keydown.enter.prevent="addTag($event)" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { usePromptBuilderStore, type Scene } from '@/stores/promptBuilderStore'
import { usePromptTagTools } from '@/composables/prompt/usePromptTagTools'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { useInterrogate } from '@/composables/useInterrogate'
import { confirmAction } from '@/composables/useConfirm'
import { applyInterrogateResult } from '@/composables/prompt/applyInterrogateResult'
import {
  OUTFIT_BUNDLES,
  OUTFIT_TAG_LABELS,
  R18_CONTROLS,
  TAG_CATEGORY_LABELS,
  NON_MANUAL_TAGS,
  normalizeCatalogKey,
} from '@/composables/scene/useDirectorCatalog'
import { UNIVERSAL_WARDROBE_PRESETS } from '@/config/universalWardrobe'
import '@/assets/css/director/components/DirectorTagWorkbench.css'

interface TagEntry {
  en: string
  cn: string
  cat: string
  aliases?: string[]
  desc?: string
}

const pb = usePromptBuilderStore()
const { tagMeaning, tagLabel, tagWeightTier, toggleOutfitBundle, addTag } = usePromptTagTools(pb)

const tagSearch = ref('')
const tagCategory = ref('all')

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

// 本地反推（Tag → manualTags / Caption → visualDescription，切人保留）
const interrogateInputRef = ref<HTMLInputElement | null>(null)
const { busy: interrogateBusy, error: interrogateErrorRaw, interrogate } = useInterrogate()
const interrogateError = computed(() => interrogateErrorRaw.value)
// 反推引擎徽标：真实模型（wd14）高亮，启发式兜底置灰并如实标注
const interrogateMeta = ref<{ label: string; title: string; fallback: boolean } | null>(null)
function triggerInterrogatePick() { interrogateInputRef.value?.click() }
async function onInterrogateFile(e: Event) {
  var input = e.target as HTMLInputElement
  var file = input.files && input.files[0]
  if (!file) return
  input.value = ''
  try {
    var result = await interrogate(file, 'tag', 0.35)
    if (!result) return
    if (result.engine === 'wd14') {
      interrogateMeta.value = {
        label: `WD14 · ${result.model || 'wd14'}`,
        title: `真实反推模型（本地 ONNX，零网络）。角色：${(result.characterTags || []).join(', ') || '未识别'}`,
        fallback: false,
      }
    } else if (result.engine === 'heuristic') {
      interrogateMeta.value = { label: '启发式兜底', title: result.warning || '未找到真实反推模型，当前为演示标签', fallback: true }
    } else {
      interrogateMeta.value = { label: result.engine, title: `引擎：${result.engine}`, fallback: false }
    }
    await applyInterrogateResult(pb, result)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    pb.flash('反推失败：' + msg)
    console.warn('[interrogate]', msg)
  }
}

const tagCatalog = computed<TagEntry[]>(() => {
  const merged = new Map<string, TagEntry>(
    pb.tags
      .filter((tag): tag is TagEntry => typeof tag.en === 'string' && tag.cat !== 'Quality' && !NON_MANUAL_TAGS.has(normalizeCatalogKey(tag.en)))
      .map(tag => [tag.en, tag]),
  )
  const addSceneTag = (raw: unknown) => {
    const source = String(raw || '').trim()
    if (!source || /^<lora:/i.test(source) || /^break$/i.test(source)) return
    const en = normalizeCatalogKey(source)
    if (!en || en.length > 64 || NON_MANUAL_TAGS.has(en) || merged.has(en)) return
    const mature = /(?:^|_)(?:r18|adult|nsfw|nude|topless|nipples|explicit|pussy|penis|sex|lingerie)(?:_|$)/i.test(en)
    const official = Boolean(OUTFIT_TAG_LABELS[en])
    merged.set(en, {
      en,
      cn: OUTFIT_TAG_LABELS[en] || (mature ? '场景成人词' : '场景词条'),
      cat: official ? 'Official Outfit' : (mature ? 'Mature' : 'Scene'),
    })
  }
  pb.scenes.forEach((scene: Scene) => {
    ;(scene.tags || []).forEach(addSceneTag)
    String(scene.prompt || '').split(',').forEach(addSceneTag)
  })
  OUTFIT_BUNDLES.forEach(bundle => bundle.tags.forEach(en => {
    if (!merged.has(en)) merged.set(en, {
      en,
      cn: OUTFIT_TAG_LABELS[en] || 'v18 训练服装词',
      cat: 'Official Outfit',
    })
  }))
  return [...merged.values()]
})

const tagCategories = computed(() => {
  const found = new Set(tagCatalog.value.map(tag => tag.cat).filter(Boolean))
  return ['all', ...found].map(id => ({ id, label: TAG_CATEGORY_LABELS[id] || id }))
})

/** 一次最多渲染多少条：目录基数远大于此，硬截断必须如实告知（见 hiddenTagCount）。 */
const TAG_RENDER_LIMIT = 72

const matchedTags = computed(() => {
  const q = tagSearch.value.trim().toLowerCase()
  return tagCatalog.value
    .filter(tag => tagCategory.value === 'all' || tag.cat === tagCategory.value)
    .filter(tag => {
      if (!q) return true
      if (tag.en.toLowerCase().includes(q)) return true
      if (tag.cn && tag.cn.toLowerCase().includes(q)) return true
      if (Array.isArray(tag.aliases) && tag.aliases.some(a => a.toLowerCase().includes(q))) return true
      const meaning = tagMeaning(tag.en, tag.cn).toLowerCase()
      return meaning.includes(q)
    })
    .sort((a, b) => Number(pb.manualTags.has(b.en)) - Number(pb.manualTags.has(a.en)))
})

const visibleTags = computed(() => matchedTags.value.slice(0, TAG_RENDER_LIMIT))

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

function isPresetActive(tags: string[]): boolean {
  if (!tags.length) return false
  if (pb.isPopular && pb.outfitOverride) {
    const set = new Set(pb.outfitOverride.tokens)
    return tags.every(t => set.has(t))
  }
  return tags.every(t => pb.manualTags.has(t))
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
