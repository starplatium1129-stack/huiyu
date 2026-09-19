import { ref } from 'vue'
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import { mutualGroupWithCategory } from '@/utils/promptPolicy'

type PromptBuilderStore = ReturnType<typeof usePromptBuilderStore>

/**
 * 绘图页「词条工作台」工具簇（2026-08-22 自 PromptBuilderView 下沉）。
 *
 * 手输 Danbooru 标签回车添加、chip 中文释义（tagMeaning 字典懒加载，
 * 避免把 ~20KB 纯数据钉进路由主块）、权重色彩热力分级与服装词包整包切换。
 * 词条的增删本体走 pb.toggleManualTag / pb.manualTags，这里只做输入归一
 * 与展示辅助。
 */
export function usePromptTagTools(pb: PromptBuilderStore) {
  /* ── 词条释义字典（懒加载）───────────────────────────────────────────
   * tagMeaning.ts 是 ~20KB 纯数据字典，只服务词条 chip 的 tooltip 与中文
   * 副标题，静态导入会把它钉进路由主块（当时 146KiB 预算只剩 0.6KiB）。
   * 改为首次调用时动态拉取：字典到位前退回目录中文标签或词条本身，
   * 到位后 ref 触发重渲染补齐释义。 */
  type TagMeaningFn = typeof import('@/utils/tagMeaning')['tagMeaning']
  const tagMeaningLookup = ref<TagMeaningFn | null>(null)
  let tagMeaningRequested = false
  function tagMeaning(tag: string, catalogLabel = ''): string {
    if (!tagMeaningRequested) {
      tagMeaningRequested = true
      void import('@/utils/tagMeaning').then(m => { tagMeaningLookup.value = m.tagMeaning }).catch(() => { tagMeaningRequested = false })
    }
    catalogLabel = pb.tagDictionary.lookup(tag)?.zhLabel || catalogLabel
    const lookup = tagMeaningLookup.value
    if (!lookup) return catalogLabel || tag
    return lookup(tag, catalogLabel)
  }

  /** chip 里的中文释义；完全未知的词条不占位（字典未就绪时同样不占位） */
  function tagLabel(tag: string): string {
    const meaning = tagMeaning(tag)
    if (!/[\u4e00-\u9fa5]/.test(meaning)) return ''
    return meaning
  }

  /** 词条权重色彩热力等级（NovelAI 视觉分级：强增强、增强、弱化、标准） */
  function tagWeightTier(tag: string): 'strong-boost' | 'boost' | 'reduce' | 'normal' {
    const match = tag.match(/:\s*([0-9.]+)\s*\)/)
    if (match) {
      const val = parseFloat(match[1])
      if (val >= 1.25) return 'strong-boost'
      if (val > 1.05) return 'boost'
      if (val < 0.95) return 'reduce'
    }
    if (/^(\({1,3}|\{{1,3})/.test(tag)) return 'boost'
    if (/^\[{1,3}/.test(tag)) return 'reduce'
    return 'normal'
  }

  /**
   * 输入框回车加词（2026-08-30 UX 审计 P0-3 重写）。
   *
   * ① 支持逗号 / 中文逗号 / 顿号 / 换行分隔。从 Danbooru 复制
   *    `blue_hair, smile, twintails` 一次回车应得到 3 个词条，
   *    而不是 1 个垃圾词条 `blue_hair,_smile,_twintails`——批量粘贴
   *    是「提示词自主权」最高频的动作，这条不通等于自主权打折。
   * ② 支持别名自动解析（dof、jk、qipao 自动转为标准 Danbooru 英文）。
   * ③ 用幂等 add 而非 toggle：输入已有词条不再把它删掉。
   */
  function addTag(e: Event) {
    const input = e.target as HTMLInputElement
    const parts = input.value
      .split(/[,，、\r\n]+/)
      .map(s => s.trim())
      .filter(Boolean)
    if (!parts.length) return
    let added = 0
    let dup = 0
    for (const tag of parts) {
      const resolved = pb.tagDictionary.canonicalize(tag)
      const canonicalTag = resolved === tag && /^[\w\s-]+$/.test(tag) && tag !== 'BREAK'
        ? tag.replace(/\s+/g, '_').toLowerCase() : resolved
      if (pb.addManualTag(canonicalTag) === 'duplicate') dup++
      else added++
    }
    input.value = ''
    if (dup) pb.flash(`已添加 ${added} 个，跳过 ${dup} 个已存在`)
    else if (added > 1) pb.flash(`已添加 ${added} 个词条`)
  }

  function toggleOutfitBundle(tags: string[]) {
    const next = new Set(pb.manualTags)
    const selected = tags.every(tag => next.has(tag))
    const incomingOutfitGroups = new Set(tags.flatMap(tag => {
      const hit = mutualGroupWithCategory(tag)
      return hit?.category === 'outfit' ? [hit.group] : []
    }))
    if (!selected && incomingOutfitGroups.size) {
      for (const tag of next) {
        const hit = mutualGroupWithCategory(tag)
        if (hit?.category === 'outfit' && !incomingOutfitGroups.has(hit.group)) next.delete(tag)
      }
    }
    tags.forEach(tag => {
      if (selected) next.delete(tag)
      else next.add(tag)
    })
    pb.manualTags = next
  }

  return { addTag, tagMeaning, tagLabel, tagWeightTier, toggleOutfitBundle }
}
