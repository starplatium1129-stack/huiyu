import { randomVariationContext, randomVariationSource } from '@/utils/randomVariationContext'
import { ref, watch } from 'vue'
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import { type RandomInspirationOptions } from '@/utils/randomPromptAssembler'
import { defaultOutfit, findCharacter, findOutfit } from '@/utils/popularContent.ts'
import { randomCandidates, type RandomRecipe } from '@/utils/randomPromptRecipe'
import { sceneSupportsCharacter } from '@/utils/promptPolicy'
import { sceneShot, sceneLighting } from '@/utils/sceneInference'
import { inferBlueprintDecisions } from '@/utils/popularBlueprintDecisions'
import type { RandomSceneContext } from '@/utils/randomSceneVariation'
import { downloadBlob } from '@/utils/downloadBlob'

/**
 * 随机灵感桥接层（2026-08-29，见 docs/guides/engineering/random-prompt-assembler-design.md）。
 *
 * 职责：读 store 已加载数据（tags / loraMeta 官方服装 / popular 角色词条）→
 * 调纯函数采样器 randomPromptPlan → 写回 store 各风格层字段 → 维护撤销快照。
 *
 * 2026-08-29 扩展：热门角色（popular）模式开放随机灵感。身份排除集 =
 * 当前角色 identityTokens + exactTokens；服装来源由独立选项控制，采样结果写回 selections/manualTags/artistStyleIds，
 * 与 studio 模式共用同一套撤销快照。
 *
 * 不新增任何门控/开关：Mature 池无独立开关（本地直连本就放行）；
 * 画师默认不注入（includeArtists 由组件开关控制，默认 false）。
 */

export function useRandomInspiration() {
  const pb = usePromptBuilderStore()

  /** 「随机画师」开关（默认关闭：不加画师 tag，保留角色原生画风）。 */
  const includeArtists = ref(false)
  const candidates = ref<ReturnType<typeof randomCandidates>>([])
  const lastRecipe = ref<RandomRecipe | null>(null)
  let snapshotRecipe: RandomRecipe | null = null
  let candidateContext = ''
  const contextKey = () => JSON.stringify([pb.char, pb.sceneId, pb.subject, pb.projectId, pb.outfitOverride])

  function clearCandidates() {
    candidates.value = []
    candidateContext = ''
  }

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

  // Previews and exported recipes describe the state they were created for.
  // Manual edits must not be overwritten by a now-stale preview.
  watch(() => pb.snapshotStyleLayers(), () => {
    if (applying) return
    clearCandidates()
    lastRecipe.value = null
  }, { deep: true, flush: 'sync' })

  watch([includeArtists, () => pb.tags, () => pb.dataReady, () => pb.scenes, () => pb.sceneBlueprints, () => pb.loraMeta, () => pb.popularCharacters], clearCandidates, { deep: true, flush: 'sync' })

  watch(contextKey, () => {
    lastSnapshot.value = null
    snapshotGenerated = []
    generatedArtists.clear()
    clearCandidates()
    lastRecipe.value = null
    snapshotRecipe = null
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

  /** Stable identity anchors; explicit outfit choices are protected separately. */
  function popularIdentityExclude(): Set<string> | null {
    const subject = pb.subject
    if (subject.kind !== 'popular') return null
    const character = findCharacter(pb.popularCharacters, subject.characterId)
    if (!character) return null
    return new Set<string>([
      ...character.identityTokens,
      ...(character.exactTokens || []),
    ])
  }

  /** 掷一次随机灵感：快照当前状态 → 采样 → 写回 store。 */
  function prepareCandidates(count = 1, seed = Math.floor(Math.random() * 4294967296)): boolean {
    clearCandidates()
    if (!pb.dataReady || !pb.tags.length) {
      pb.flash('随机灵感需要数据就绪，请稍候再试', 2500, 'warning')
      return false
    }
    const identityExclude = pb.isPopular ? popularIdentityExclude() : null
    if (pb.isPopular && !identityExclude) {
      pb.flash('当前热门角色数据缺失，无法随机', 2500, 'warning')
      return false
    }
    let scene: RandomSceneContext | undefined
    let allowClothing = !pb.outfitOverride
    let outfits = officialOutfitsFor(pb.char)
    if (pb.subject.kind === 'popular') {
      const character = findCharacter(pb.popularCharacters, pb.subject.characterId)!
      const selectedOutfit = findOutfit(character, pb.subject.outfitId)
      allowClothing &&= !selectedOutfit || selectedOutfit.id === defaultOutfit(character)?.id
      outfits = Object.fromEntries(character.outfits.map(outfit => [outfit.id, outfit.tokens]))
      if (pb.subject.blueprintId) {
        const blueprintId = pb.subject.blueprintId
        const blueprint = pb.sceneBlueprints.find(item => item.id === blueprintId && (!item.characterId || item.characterId === character.id))
        if (!blueprint) { pb.flash('当前场景尚未就绪，无法随机', 2500, 'warning'); return false }
        allowClothing = !pb.outfitOverride && (!selectedOutfit || selectedOutfit.id === defaultOutfit(character)?.id || selectedOutfit.id === blueprint.outfitId)
        const decisions = inferBlueprintDecisions(blueprint)
        scene = { source: randomVariationSource(blueprint), prompt: blueprint.promptTokens.join(', '), prose: blueprint.promptProse,
          tags: blueprint.sceneTags, action: blueprint.action, time: blueprint.timeOfDay,
          shot: decisions.shot, lighting: decisions.lighting }
      }
    } else if (pb.sceneId) {
      const active = pb.activeScene
      if (!active || !sceneSupportsCharacter(active, pb.char)) { pb.flash('当前场景不支持此角色，无法随机', 2500, 'warning'); return false }
      scene = { source: randomVariationSource(active), prompt: active.prompt ?? '', prose: active.animaCaption ?? '', tags: active.tags ?? [],
        action: typeof active.action === 'string' ? active.action : '', time: active.timeOfDay ?? active.time ?? '',
        shot: sceneShot(active), lighting: sceneLighting(active) }
    }
    const shared = { context: randomVariationContext(pb), scene, rich: true, allowClothing, officialOutfits: outfits }
    const options: RandomInspirationOptions = identityExclude
      ? {
          ...shared, identityExclude,
          includeArtists: includeArtists.value,
          keepArtists: pb.artistStyleIds.filter(id => !generatedArtists.has(id)),
          tags: pb.tags,
        }
      : {
          ...shared, char: pb.char,
          includeArtists: includeArtists.value,
          keepArtists: pb.artistStyleIds.filter(id => !generatedArtists.has(id)),
          tags: pb.tags,
        }
    try { candidates.value = randomCandidates(options, seed, count) }
    catch (error) { pb.flash((error as Error).message, 2500, 'warning'); return false }
    candidateContext = contextKey()
    return true
  }

  function applyCandidate(index: number): boolean {
    const candidate = candidates.value[index]
    if (!pb.dataReady || !candidate || candidateContext !== contextKey()) return false
    const { draw, recipe } = candidate
    // A second click must not replace the original undo snapshot with itself.
    if (lastRecipe.value === recipe) return true

    lastSnapshot.value = pb.snapshotStyleLayers()
    snapshotRecipe = lastRecipe.value
    snapshotGenerated = [...generatedArtists]
    const retainedArtists = new Set(recipe.config.keepArtists)
    applying = true
    try {
      pb.randomVariation = JSON.parse(JSON.stringify(draw.variation))
      pb.selections.emotion = [...draw.emotions]
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
    lastRecipe.value = recipe

    pb.flash(draw.kept.length ? `随机灵感已应用；本次保持：${draw.kept.join('、')}` : '自由随机灵感已应用，可继续手改或再掷', 4000, 'info')
    return true
  }

  function roll(seed?: number): boolean { return prepareCandidates(1, seed) && applyCandidate(0) }
  function exportRecipe() {
    if (!lastRecipe.value) return
    downloadBlob(new Blob([JSON.stringify(lastRecipe.value, null, 2)], { type: 'application/json' }), `huiyu-inspiration-${lastRecipe.value.seed}.json`)
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
    lastRecipe.value = snapshotRecipe
    snapshotRecipe = null
    clearCandidates()
    pb.flash('已撤销上一组随机灵感', 2000, 'info')
    return true
  }

  return { includeArtists, roll, undo, hasUndo: lastSnapshot, candidates, lastRecipe, prepareCandidates, applyCandidate, exportRecipe }
}
