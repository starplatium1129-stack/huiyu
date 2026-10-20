import type { AnimaGenerationState } from '@/types/anima'
import type { CharKey, HistoryEntry, Selections } from '@/types/promptHistory'
import type { Scene } from '@/types/scene'
import type { PromptPlan } from '@/types/prompt'
import { isGarmentToken } from '@/utils/popularIdentity'
import { authoredSceneCaption } from '@/utils/promptCaption'
import { isStableIdentityToken } from '@/utils/interrogateReference'
import { roamingIdentityReferences } from '@/utils/promptRoaming'
import type { DirectorControlSources } from '@/types/promptDirector'
import type { PromptLoraMetadata } from '@/utils/studioPromptBuilder'
import type { DraftOutfitOverride } from '@/utils/promptBuilderPersistence'
import { endfieldAnimaBinding } from '@/utils/loraCatalog'
import { identityDomainOf } from '@/utils/interrogateMerge'
import { sceneStyleBaseline } from '@/utils/randomVariationContext'
import { artistStyleProse, artistTagsForEngine } from '@/config/artistStyles'
import { popularPortraitSrc } from '@/utils/popularPortraitSource'
import { compilePromptRecipe } from '@/utils/promptRecipe'
import { inferBlueprintDecisions } from '@/utils/popularBlueprintDecisions'
import { findCharacter as findPopularCharacter, defaultOutfit, findOutfit, type DrawSubject, type SceneBlueprint, type PopularCharacter } from '@/utils/popularContent'
import { CHAR_PROMPT, COLOR_MOODS, STUDIO_PROMPT_SUBJECTS } from '@/config/promptConstants'
import { mutualGroupWithCategory, normalizeKey, tokenize, type ModelProfile } from '@/utils/promptPolicy'
import { isManualDirectorValue, sceneDirectorSources } from '@/utils/promptDirector'
import { sceneShot, sceneLighting, sceneComposition, sceneColorMood, sceneRecommendedSize } from '@/utils/sceneInference'
import { ANIMA_LORA_BY_CHARACTER, closestSupportedSize } from '../generation/animaSessionContract'
import { buildAnimaRequest } from '../generation/buildAnimaRequest'
import type { BatchDrawRunnerInput, BatchTargetItem } from '../generation/useBatchDraw'
import type { PreparedBatchImage } from './batchGenerationPlan'

interface PromptBatchSource {
  subject: DrawSubject
  char: CharKey
  selections: Selections
  directorSources?: DirectorControlSources
  loraMeta?: PromptLoraMetadata[]
  manualTags: string[]
  outfitOverride: DraftOutfitOverride | null
  activeScene: Scene | null
  sceneBlueprints: SceneBlueprint[]
  emotionPrompt: string
  tags: Array<{ cat: string; en: string }>
  artistStyleIds: string[]
  colorMood: string | null
  visualDescription: string
  negativeCustom?: string
  projectId: string
}

export interface PromptBatchRecipeInput {
  source: PromptBatchSource
  characters: PopularCharacter[]
  blueprints: SceneBlueprint[]
  scenes?: Scene[]
  sourcePlan?: PromptPlan | null
  state: AnimaGenerationState
  profile: ModelProfile | null
  negativePrompt: string
}

/** One detached recipe owns new-batch inputs; it never reads the live editor. */
export function createPromptBatchRecipe(input: PromptBatchRecipeInput) {
  const { source: pb, characters, blueprints, scenes = [], sourcePlan, state, profile, negativePrompt } = JSON.parse(JSON.stringify(input)) as PromptBatchRecipeInput
  const blueprintList = () => blueprints
  const getPopularList = () => characters
  type StyleSnapshot = Pick<HistoryEntry, 'emotion' | 'shot' | 'lighting' | 'composition' | 'colorMood' | 'directorSources'>
  const plans = new Map<string, { negative?: string; profile?: ModelProfile | null; adult?: boolean; outfitId?: string; outfitExplicit?: boolean; outfitOverride?: DraftOutfitOverride | null; size?: string; manual: string[]; visualDescription: string; style: StyleSnapshot }>()

  let roamingContent = { tags: [] as string[], caption: '' }

  /** Transfer authored content before rendering; never parse a model's final prose back into tags. */
  function captureRoamingContent(captionOverride: string): string {
    const source = pb.subject.kind === 'popular' ? findPopularCharacter(characters, pb.subject.characterId) : null
    const keys = new Set([
      ...(source?.identityTokens || []), ...(source?.exactTokens || []), ...(source?.characterTokens || []),
      ...(source?.copyrightTokens || []),
      ...Object.values(CHAR_PROMPT).flatMap(tokenize),
      ...Object.values(STUDIO_PROMPT_SUBJECTS).flatMap(subject => subject.copyrightTokens),
    ].filter(token => !isGarmentToken(token) && mutualGroupWithCategory(token)?.category !== 'outfit').map(normalizeKey))
    if (sourcePlan) {
      const tags = [...sourcePlan.rating, ...sourcePlan.sceneVisualFragments, ...sourcePlan.exactControls, ...sourcePlan.emotion, ...sourcePlan.camera,
        ...sourcePlan.lighting, ...sourcePlan.palette, ...sourcePlan.composition, ...sourcePlan.manual]
        .filter(tag => !keys.has(normalizeKey(tag)) && !identityDomainOf(tag) && !/^(?:nene|natsume)_/i.test(tag))
      const caption = sourcePlan.scene?.animaCaption || sourcePlan.sceneProse || ''
      const sceneCaption = captionOverride.trim() || (caption || sourcePlan.visualDescription ? authoredSceneCaption(sourcePlan, caption).trim().replace(/^\.\s*/, '') : '')
      roamingContent = { tags: [...new Set(tags.filter(tag => !isStableIdentityToken(tag)))],
        caption: [sourcePlan.outfitProse ? `She wears ${sourcePlan.outfitProse.replace(/[.!?]+$/, '')}.` : '', sceneCaption].filter(Boolean).join(' ') }
    } else {
      roamingContent = { tags: pb.manualTags.filter(tag => !keys.has(normalizeKey(tag)) && !isStableIdentityToken(tag)),
        caption: captionOverride.trim() || pb.visualDescription.trim() }
    }
    return [roamingContent.tags.join(', '), roamingContent.caption].filter(Boolean).join('\n')
  }

  function resolveTargetCharacter(target: BatchTargetItem) {
    const charId = target.kind === 'character' ? target.characterId || target.id
      : blueprintList().find(item => item.id === target.id)?.characterId || scenes.find(item => item.id === target.id)?.char
    if (!charId) return null
    const popularChars = getPopularList()
    const popChar = findPopularCharacter(popularChars, charId)
    if (popChar) return { kind: 'popular' as const, char: popChar }
    if (charId === 'nene' || charId === 'natsume' || charId === 'triad') {
      return { kind: 'studio' as const, charKey: charId as 'nene' | 'natsume' | 'triad' }
    }
    return null
  }

  /**
   * 从当前手动词条/提示词中检测是否指定了互斥服装（如泳装、女仆等），
   * 若有则返回该服装的 tokens，供所有角色全员换装顶替。
   */
  function detectOutfitOverrideFromContext(): string[] | null {
    if (pb.outfitOverride?.tokens?.length) {
      return [...pb.outfitOverride.tokens]
    }
    const tags = [...pb.manualTags]
    const outfitTokens: string[] = []
    for (const tag of tags) {
      const hit = mutualGroupWithCategory(tag)
      if (hit && hit.category === 'outfit') {
        outfitTokens.push(tag)
      }
    }
    return outfitTokens.length ? outfitTokens : null
  }

  /** 组装最终出图 prompt：根据目标是场景还是多角色自适应。 */
  function buildTargetPrompt(input: BatchDrawRunnerInput): string {
    const target = input.scene
    const rawText = String(target.prose || '')
    // Captured Anima prompts retain even an empty tag/caption line as the section boundary.
    const baseText = target.kind === 'character' && state.family === 'anima' ? rawText : rawText.trim()

    const charInfo = resolveTargetCharacter(target)
    if (charInfo?.kind === 'popular') {
      const pop = charInfo.char
      const blueprint = target.kind === 'scene' ? blueprintList().find(item => item.id === target.id) || null : null
      const selected = !blueprint && pb.subject.kind === 'popular' && pb.subject.characterId === pop.id
        ? findOutfit(pop, pb.subject.outfitId) : null
      const outfit = (blueprint?.outfitId ? findOutfit(pop, blueprint.outfitId) : null) || selected || defaultOutfit(pop)
      if (!outfit) throw new Error('目标角色没有可用服装')
      const outfitExplicit = Boolean(selected && pb.subject.kind === 'popular'
        && (pb.subject.outfitExplicit ?? selected.id !== defaultOutfit(pop)?.id))
      const outfitOverride = detectOutfitOverrideFromContext()
      const source = pb.subject.kind === 'popular' ? findPopularCharacter(getPopularList(), pb.subject.characterId) : null
      const sourceKeys = new Set([...(source?.identityTokens || []), ...(source?.outfits.flatMap(item => item.identityTokensOverride || []) || []), ...(source?.exactTokens || []), ...(source?.copyrightTokens || []), ...(source?.characterTokens || []), ...(source?.aliases || []), ...(CHAR_PROMPT[pb.char] || '').split(','), ...(STUDIO_PROMPT_SUBJECTS[pb.char]?.copyrightTokens || [])].map(normalizeKey))
      const engine = state.family === 'krea2' ? 'krea2' : 'anima'
      const decisions = blueprint ? inferBlueprintDecisions(blueprint) : null
      const currentSubject = pb.subject
      const sourceBlueprint = currentSubject.kind === 'popular' && currentSubject.blueprintId
        ? pb.sceneBlueprints.find(item => item.id === currentSubject.blueprintId) : null
      sourceBlueprint?.identityTokensOverride?.forEach(token => sourceKeys.add(normalizeKey(token)))
      const inherited = !blueprint ? null : sourceBlueprint ? inferBlueprintDecisions(sourceBlueprint)
        : currentSubject.kind === 'studio' && pb.activeScene ? sceneStyleBaseline(pb.activeScene) : null
      const directorSources: DirectorControlSources = {}
      const pick = (key: 'shot' | 'lighting' | 'composition') => {
        const manual = isManualDirectorValue(pb.directorSources, key, pb.selections[key], inherited?.[key])
        directorSources[key] = manual ? 'manual' : 'scene'
        return manual ? pb.selections[key] : decisions?.[key] ?? null
      }
      const shot = pick('shot'), lighting = pick('lighting'), composition = pick('composition')
      const colorMood = isManualDirectorValue(pb.directorSources, 'colorMood', pb.colorMood, inherited?.colorMood) ? pb.colorMood : null
      directorSources.colorMood = isManualDirectorValue(pb.directorSources, 'colorMood', pb.colorMood, inherited?.colorMood) ? 'manual' : 'scene'
      const mood = COLOR_MOODS.find(option => option.id === (colorMood ?? decisions?.colorMood))
      const inheritedTags = target.kind === 'character' ? roamingContent.tags : []
      const manual = (target.kind === 'character' ? inheritedTags : pb.manualTags)
        .filter(tag => !identityDomainOf(tag) && !sourceKeys.has(normalizeKey(tag)))
      const visualDescription = target.kind === 'character' ? roamingContent.caption : pb.visualDescription
      const planResult = compilePromptRecipe({
        kind: 'popular', character: pop, outfit, blueprint, engine, profile, directorSources,
        manual,
        emotion: pb.emotionPrompt ? [pb.emotionPrompt] : [],
        shot, lighting, composition,
        palette: mood ? tokenize(mood.prompt) : [],
        visualDescription,
        negativeCustom: pb.negativeCustom,
        outfitOverride, outfitExplicit,
        matureTokens: new Set(pb.tags.filter(tag => tag.cat === 'Mature').map(tag => normalizeKey(tag.en))),
        artistTags: artistTagsForEngine(pb.artistStyleIds, engine), artistProse: artistStyleProse(pb.artistStyleIds, engine),
      })
      plans.set(target.id, { negative: planResult.negative, profile: planResult.profile, adult: planResult.adult, outfitId: outfit.id, outfitExplicit, manual, visualDescription,
        outfitOverride: outfitOverride ? { tokens: [...outfitOverride], replaced: pb.outfitOverride?.replaced ?? null } : null, size: blueprint?.recommendedSize,
        style: { emotion: pb.emotionPrompt ? [...pb.selections.emotion] : [], shot,
          lighting, composition, colorMood: mood?.id ?? null, directorSources } })
      return planResult.prompt
    }
    if (charInfo?.kind === 'studio') {
      const engine = state.family === 'krea2' ? 'krea2' : 'anima'
      const blueprint = target.kind === 'scene' ? blueprintList().find(item => item.id === target.id) : null
      const scene: Scene = target.kind === 'scene'
        ? scenes.find(item => item.id === target.id) || {
            ...blueprint, id: target.id, title: target.title, char: charInfo.charKey,
            prompt: blueprint?.promptTokens.join(', ') || '',
            animaCaption: blueprint?.promptProse || baseText,
            negative: blueprint?.negativeTokens.join(', ') || '',
            rating: blueprint?.adult ? 'R18' : 'All',
          }
        : {
            id: 'batch-roaming', title: target.title, char: charInfo.charKey,
            character: [charInfo.charKey],
            prompt: roamingContent.tags.join(', '),
            animaCaption: roamingContent.caption,
          }
      const inherited = pb.activeScene ? sceneStyleBaseline(pb.activeScene) : null
      const defaults = { shot: sceneShot(scene), lighting: sceneLighting(scene), composition: sceneComposition(scene) }
      const directorSources: DirectorControlSources = target.kind === 'character' ? { ...pb.directorSources } : sceneDirectorSources()
      const selection = (key: 'shot' | 'lighting' | 'composition') => {
        const manual = isManualDirectorValue(pb.directorSources, key, pb.selections[key], inherited?.[key])
        directorSources[key] = manual ? 'manual' : 'scene'
        return manual ? pb.selections[key] : defaults[key]
      }
      const shot = selection('shot'), lighting = selection('lighting'), composition = selection('composition')
      const manualColor = isManualDirectorValue(pb.directorSources, 'colorMood', pb.colorMood, inherited?.colorMood)
      const colorMood = manualColor ? pb.colorMood : sceneColorMood(scene)
      directorSources.colorMood = manualColor ? 'manual' : 'scene'
      const activeLora = charInfo.charKey === 'triad' ? null
        : pb.subject.kind === 'studio' && pb.char === charInfo.charKey ? state.loraId : ANIMA_LORA_BY_CHARACTER[charInfo.charKey]
      const controls = detectOutfitOverrideFromContext()
      const result = compilePromptRecipe({
        kind: 'studio', character: charInfo.charKey, scene, engine, profile,
        activeLoras: activeLora ? { [charInfo.charKey]: activeLora } : {}, loraMeta: pb.loraMeta,
        shot, lighting, composition, directorSources,
        palette: tokenize(COLOR_MOODS.find(mood => mood.id === colorMood)?.prompt || ''),
        negativeCustom: pb.negativeCustom,
        controls: controls || (target.kind === 'character' ? [] : undefined),
        manual: target.kind === 'character' ? roamingContent.tags : [...pb.manualTags], emotion: pb.emotionPrompt ? [pb.emotionPrompt] : [],
        visualDescription: target.kind === 'scene' ? pb.visualDescription : '',
        artistTags: artistTagsForEngine(pb.artistStyleIds, engine), artistProse: artistStyleProse(pb.artistStyleIds, engine),
      })
      plans.set(target.id, { negative: result.negative, profile: result.profile, adult: result.adult,
        manual: target.kind === 'character' ? [...roamingContent.tags] : [...pb.manualTags],
        visualDescription: target.kind === 'character' ? roamingContent.caption : pb.visualDescription,
        size: target.kind === 'scene' ? sceneRecommendedSize(scene) : undefined,
        style: { emotion: [...pb.selections.emotion], shot, lighting, composition, colorMood, directorSources } })
      return result.prompt
    }
    if (target.kind === 'character') throw new Error('目标角色已不可用')
    throw new Error('场景蓝图缺少有效的角色绑定')
  }

  function batchSceneProse(blueprint: SceneBlueprint | undefined): string {
    const prose = String(blueprint?.promptProse || '').trim()
    if (prose) return prose
    return [blueprint?.description, blueprint?.action, blueprint?.lighting].filter(Boolean).join('，')
  }
  function prepareBatchAnima(input: BatchDrawRunnerInput): PreparedBatchImage {
    const prompt = buildTargetPrompt(input)
    if (!prompt) throw new Error('出图描述或角色配置为空')
    const target = input.scene
    const charInfo = resolveTargetCharacter(target)
    const isTargetPopular = charInfo?.kind === 'popular'

    const endfield = endfieldAnimaBinding(isTargetPopular ? charInfo.char.id : null, state.family, state.modelId)
    const targetChar = charInfo?.kind === 'studio' ? charInfo.charKey : pb.char
    const recommendedSize = plans.get(target.id)?.size
    const dimensions = /^(\d+)\s*[x×]\s*(\d+)$/.exec(recommendedSize
      ? closestSupportedSize(state.models.find(model => model.id === state.modelId), recommendedSize.replace('×', 'x')) : '')
    const targetState = {
      ...state,
      width: dimensions ? Number(dimensions[1]) : state.width,
      height: dimensions ? Number(dimensions[2]) : state.height,
      seed: input.seed >= 0 ? input.seed : null,
      // Cross-character roaming selects the target's installed binding; the source
      // character keeps its captured selection for the shared admission check.
      loraId: charInfo?.kind === 'studio' && (pb.subject.kind !== 'studio' || targetChar !== pb.char)
        ? charInfo.charKey === 'triad' ? '' : ANIMA_LORA_BY_CHARACTER[charInfo.charKey] : state.loraId,
      // Batch Endfield recipes retain the collection's default strength.
      loraStrength: endfield?.loraStrength ?? state.loraStrength,
    }
    const request = buildAnimaRequest({
      subject: isTargetPopular
        ? { kind: 'popular', characterId: charInfo.char.id, outfitId: plans.get(target.id)?.outfitId || '', blueprintId: target.kind === 'scene' ? target.id : null }
        : { kind: 'studio' },
      char: targetChar, state: targetState, profile: plans.get(target.id)?.profile ?? profile, prompt,
      negative: plans.get(target.id)?.negative ?? (state.family === 'krea2' ? '' : negativePrompt),
    })
    const history: PreparedBatchImage['history'] = {
        ...plans.get(target.id)!.style,
        seed: request.seed, negative: request.negative, prompt,
        size: `${request.width}x${request.height}`, engine: state.family === 'krea2' ? 'krea2' as const : 'anima' as const,
        model: request.modelId, profile: request.profileId, loraId: request.loraId, loraStrength: request.loraStrength,
        lora: request.loraId, noLora: !request.loraId, styleLoraId: request.styleLoraId ?? null,
        cfg: request.cfg, steps: request.steps, sampler: state.sampler, scheduler: state.scheduler,
        visualDescription: plans.get(target.id)!.visualDescription, manual_tags: plans.get(target.id)!.manual,
        negativeCustom: pb.negativeCustom, artistStyleIds: [...pb.artistStyleIds], project: pb.projectId,
        // 精准覆盖角色元数据
        ...(isTargetPopular ? {
          subject: 'popular' as const,
          characterId: charInfo.char.id,
          outfitId: plans.get(target.id)?.outfitId || defaultOutfit(charInfo.char)?.id,
          outfitExplicit: plans.get(target.id)?.outfitExplicit,
          outfitOverride: plans.get(target.id)?.outfitOverride,
          blueprintId: target.kind === 'scene' ? target.id : null,
        } : charInfo?.kind === 'studio' ? {
          character: charInfo.charKey,
          subject: 'studio' as const,
          characterId: undefined,
        } : {}),
        story: target.prose || '',
        scene: target.kind === 'scene' ? target.id : null,
        sceneTitle: target.title || undefined,
        hiresFix: Boolean(state.hiresFix),
        hiresScale: state.hiresScale,
        hiresDenoise: state.hiresDenoise,
        hiresUpscaler: request.hiresUpscaler,
    }
    return { engine: state.family === 'krea2' ? 'krea2' : 'anima', request, history,
      adult: plans.get(target.id)?.adult === true,
      context: { history, char: history.character, characterId: history.characterId, sceneId: history.scene,
        outfitId: history.outfitId, blueprintId: history.blueprintId, story: history.story } }
  }

  function selectedSeed() {
    const seed = state.seed
    return typeof seed === 'number' && Number.isFinite(seed) && seed >= 0 ? seed : Math.floor(Math.random() * 900000000)
  }

  function sceneTargets(ids: string[]): BatchTargetItem[] {
    return ids.map(id => {
      const blueprint = blueprintList().find(item => item.id === id)
      const scene = scenes.find(item => item.id === id)
      return {
        id,
        title: blueprint?.title || scene?.title || id,
        prose: blueprint ? batchSceneProse(blueprint) : scene?.animaCaption || scene?.prompt || '',
        subtitle: blueprint?.location || blueprint?.category || scene?.location || scene?.category,
        kind: 'scene' as const,
      }
    }).filter(item => item.prose)
  }

  function characterTargets(ids: string[], captionOverride = ''): BatchTargetItem[] {
    const basePrompt = captureRoamingContent(captionOverride)
    const popularChars = getPopularList()
    const sourceId = pb.subject.kind === 'popular' ? pb.subject.characterId : pb.char
    const source = findPopularCharacter(popularChars, sourceId)
    const names = source ? [...source.aliases, source.originalName, ...(source.characterTokens || [])]
      : sourceId === 'nene' ? ['Ayachi Nene', 'Nene'] : sourceId === 'natsume' ? ['Shiki Natsume', 'Natsume'] : []
    const sourceBlueprint = pb.subject.kind === 'popular'
      ? blueprints.find(item => item.id === (pb.subject.kind === 'popular' ? pb.subject.blueprintId : null)) : null
    const intent = sourcePlan?.scene?.compositionIntent || sourceBlueprint?.compositionIntent
    if (intent && intent !== 'single')
      throw new Error('这个场景包含多人或分镜关系，请使用「按场景蓝图」保留原构图。')
    for (const id of ids) {
      if (id === sourceId) continue
      const target = findPopularCharacter(popularChars, id)
      const traits = target ? [...target.identityTokens, ...target.exactTokens] : tokenize(CHAR_PROMPT[id] || '')
      const references = roamingIdentityReferences(roamingContent.caption, names, traits)
      if (references.length) throw new Error(`画面描述中的 ${references.slice(0, 3).join('、')} 仍指向原角色。请填写适用于所选角色的通用画面描述后重试。`)
    }

    return ids.map(id => {
      const pop = findPopularCharacter(popularChars, id)
      if (pop) {
        return {
          id: pop.id,
          characterId: pop.id,
          title: pop.displayName,
          subtitle: pop.franchise,
          avatarUrl: popularPortraitSrc(pop.id),
          prose: basePrompt,
          kind: 'character',
        }
      }
      if (id === 'nene' || id === 'natsume') {
        const name = id === 'nene' ? '绫地宁宁' : '四季夏目'
        return {
          id,
          characterId: id,
          title: name,
          subtitle: '星光咖啡馆与死神之蝶',
          avatarUrl: popularPortraitSrc(id),
          prose: basePrompt,
          kind: 'character',
        }
      }
      return null
    }).filter(Boolean) as BatchTargetItem[]
  }

  return { prepare: prepareBatchAnima, sceneTargets, characterTargets, selectedSeed }
}
