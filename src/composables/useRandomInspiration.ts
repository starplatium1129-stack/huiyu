import { ref, watch } from 'vue'
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import { randomPromptPlan, type RandomDraw, type RandomInspirationOptions } from '@/utils/randomPromptAssembler'
import { defaultOutfit, findCharacter, findOutfit } from '@/utils/popularContent.ts'

/**
 * 随机灵感桥接层（2026-08-29，见 docs/guides/engineering/random-prompt-assembler-design.md）。
 *
 * 职责：读 store 已加载数据（tags / loraMeta 官方服装 / popular 角色词条）→
 * 调纯函数采样器 randomPromptPlan → 写回 store 各风格层字段 → 维护撤销快照。
 *
 * 2026-08-29 扩展：热门角色（popular）模式开放随机灵感。身份排除集 =
 * 当前角色 identityTokens + exactTokens + 当前 outfit tokens（服装由 outfit
 * 系统管理，随机不抽服装），采样结果写回 selections/manualTags/artistStyleIds，
 * 与 studio 模式共用同一套撤销快照。
 *
 * 不新增任何门控/开关：Mature 池无独立开关（本地直连本就放行）；
 * 画师默认不注入（includeArtists 由组件开关控制，默认 false）。
 */

export function useRandomInspiration() {
  const pb = usePromptBuilderStore()

  /** 「随机画师」开关（默认关闭：不加画师 tag，保留角色原生画风）。 */
  const includeArtists = ref(false)

  /** 撤销快照：仅保留最近一组（掷之前的状态）。 */
  const lastSnapshot = ref<ReturnType<typeof pb.snapshotStyleLayers> | null>(null)

  let generatedArtists = new Set<string>()
  let snapshotGenerated: string[] = []
  let applying = false

  // Only this composable's additions are eligible for replacement on a reroll.
  // A manual picker write conservatively makes the current selection user-owned.
  watch(() => pb.artistStyleIds, () => {
    if (!applying) generatedArtists.clear()
  }, { deep: true, flush: 'sync' })

  watch(() => JSON.stringify([pb.char, pb.sceneId, pb.subject, pb.projectId]), () => {
    lastSnapshot.value = null
    snapshotGenerated = []
    generatedArtists.clear()
  }, { flush: 'sync' })

  /** 自 store 已加载数据提取官方服装（loras.json outfit_guidance，V18 WD14 为事实源）。 */
  function officialOutfitsFor(char: string): Record<string, string[]> {
    const result: Record<string, string[]> = {}
    for (const meta of pb.loraMeta) {
      const name = String(meta.name || meta.id || '').toLowerCase()
      if (!name.includes(char)) continue
      const guidance = meta.outfit_guidance as unknown
      if (!guidance || typeof guidance !== 'object' || Array.isArray(guidance)) continue
      for (const [key, tokens] of Object.entries(guidance as Record<string, unknown>)) {
        if (Array.isArray(tokens) && tokens.length) {
          result[key] = tokens.filter((token): token is string => typeof token === 'string')
        }
      }
      if (Object.keys(result).length) break
    }
    return result
  }

  /** 热门角色身份排除集：identityTokens + exactTokens + 当前 outfit tokens。 */
  function popularIdentityExclude(): Set<string> | null {
    const subject = pb.subject
    if (subject.kind !== 'popular') return null
    const character = findCharacter(pb.popularCharacters, subject.characterId)
    if (!character) return null
    const outfit = findOutfit(character, subject.outfitId) ?? defaultOutfit(character)
    return new Set<string>([
      ...character.identityTokens,
      ...(character.exactTokens || []),
      ...(outfit?.tokens || []),
    ])
  }

  /** 掷一次随机灵感：快照当前状态 → 采样 → 写回 store。 */
  function roll(): boolean {
    if (!pb.dataReady || !pb.tags.length) {
      pb.flash('随机灵感需要数据就绪，请稍候再试', 2500, 'warning')
      return false
    }
    const identityExclude = pb.isPopular ? popularIdentityExclude() : null
    if (pb.isPopular && !identityExclude) {
      pb.flash('当前热门角色数据缺失，无法随机', 2500, 'warning')
      return false
    }
    const options: RandomInspirationOptions = identityExclude
      ? {
          identityExclude,
          includeArtists: includeArtists.value,
          keepArtists: pb.artistStyleIds.filter(id => !generatedArtists.has(id)),
          tags: pb.tags,
        }
      : {
          char: pb.char,
          includeArtists: includeArtists.value,
          keepArtists: pb.artistStyleIds.filter(id => !generatedArtists.has(id)),
          tags: pb.tags,
          officialOutfits: officialOutfitsFor(pb.char),
        }
    const draw: RandomDraw = randomPromptPlan(options)

    lastSnapshot.value = pb.snapshotStyleLayers()
    snapshotGenerated = [...generatedArtists]
    const retainedArtists = new Set(options.keepArtists)
    applying = true
    try {
      pb.selections.emotion = draw.emotions
      pb.selections.shot = draw.shot
      pb.selections.lighting = draw.lighting
      pb.selections.composition = draw.composition
      pb.setColorMood(draw.colorMood)
      pb.manualTags = new Set(draw.manualTags)
      pb.setArtistStyleIds(draw.artistStyleIds)
    } finally {
      applying = false
    }
    generatedArtists = new Set(draw.artistStyleIds.filter(id => !retainedArtists.has(id)))

    pb.flash('随机灵感已应用，可继续手改或再掷', 2500, 'info')
    return true
  }

  /** 撤销上一组（回到掷之前的状态）。 */
  function undo(): boolean {
    if (!lastSnapshot.value) return false
    applying = true
    try {
      pb.restoreStyleLayers(lastSnapshot.value)
    } finally {
      applying = false
    }
    generatedArtists = new Set(snapshotGenerated)
    snapshotGenerated = []
    lastSnapshot.value = null
    pb.flash('已撤销上一组随机灵感', 2000, 'info')
    return true
  }

  return { includeArtists, roll, undo, hasUndo: lastSnapshot }
}
