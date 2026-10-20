import type { AnimaGenerationState } from '@/types/anima'
import type { CharKey, HistoryEntry, Selections } from '@/types/promptHistory'
import type { Scene } from '@/types/scene'
import type { DraftOutfitOverride } from '@/utils/promptBuilderPersistence'
import { endfieldAnimaBinding } from '@/utils/loraCatalog'
import { identityDomainOf } from '@/utils/interrogateMerge'
import { sceneStyleBaseline } from '@/utils/randomVariationContext'
import { artistStyleProse, artistTagsForEngine } from '@/config/artistStyles'
import { popularPortraitSrc } from '@/utils/popularPortraitSource'
import { buildPopularPromptPlan } from '@/utils/popularPromptBuilder'
import { inferBlueprintDecisions } from '@/utils/popularBlueprintDecisions'
import { findCharacter as findPopularCharacter, defaultOutfit, findOutfit, type DrawSubject, type SceneBlueprint, type PopularCharacter } from '@/utils/popularContent'
import { CHAR_PROMPT, COLOR_MOODS, STUDIO_PROMPT_SUBJECTS } from '@/config/promptConstants'
import { mutualGroupWithCategory, normalizeKey, tokenize, type ModelProfile } from '@/utils/promptPolicy'
import { createPromptPlan, renderPromptPlan } from '@/utils/promptCompiler'
import { ANIMA_LORA_BY_CHARACTER } from '../generation/animaSessionContract'
import { buildAnimaRequest } from '../generation/buildAnimaRequest'
import type { BatchDrawRunnerInput, BatchTargetItem } from '../generation/useBatchDraw'
import type { PreparedBatchImage } from './batchGenerationPlan'

interface PromptBatchSource {
  subject: DrawSubject
  char: CharKey
  selections: Selections
  manualTags: string[]
  outfitOverride: DraftOutfitOverride | null
  activeScene: Scene | null
  sceneBlueprints: SceneBlueprint[]
  emotionPrompt: string
  tags: Array<{ cat: string; en: string }>
  artistStyleIds: string[]
  colorMood: string | null
  visualDescription: string
  projectId: string
}

export interface PromptBatchRecipeInput {
  source: PromptBatchSource
  characters: PopularCharacter[]
  blueprints: SceneBlueprint[]
  state: AnimaGenerationState
  profile: ModelProfile | null
  negativePrompt: string
}

/** One detached recipe owns new-batch inputs; it never reads the live editor. */
export function createPromptBatchRecipe(input: PromptBatchRecipeInput) {
  const { source: pb, characters, blueprints, state, profile, negativePrompt } = JSON.parse(JSON.stringify(input)) as PromptBatchRecipeInput
  const blueprintList = () => blueprints
  const getPopularList = () => characters
  type StyleSnapshot = Pick<HistoryEntry, 'emotion' | 'shot' | 'lighting' | 'composition' | 'colorMood'>
  const plans = new Map<string, { negative?: string; outfitId?: string; size?: string; style: StyleSnapshot }>()

  /**
   * 从当前完整提示词中剥离原角色的特征、专属服装与 LoRA 标签，
   * 提炼出干净的「环境、构图、光影、画面指令」通用基底。
   */
  function extractUniversalPrompt(rawPrompt: string): string {
    let text = String(rawPrompt || '').trim()
    if (!text) return ''

    // 1. 去除原 studio 角色的锚点
    Object.values(CHAR_PROMPT).forEach(anchor => {
      if (anchor) text = text.replace(anchor, '')
    })

    // 2. 去除热门角色的 identityProse 与 identityTokens
    const popularChars = pb.subject.kind === 'popular' ? getPopularList().filter(item => item.id === (pb.subject.kind === 'popular' ? pb.subject.characterId : '')) : []
    popularChars.forEach((pop: PopularCharacter) => {
      if (pop.identityProse) text = text.replace(pop.identityProse, '')
      if (pop.outfits) {
        pop.outfits.forEach(o => {
          if (o.prose) text = text.replace(o.prose, '')
          if (o.tokens) {
            o.tokens.forEach(tok => {
              text = text.split(',').filter(part => normalizeKey(part) !== normalizeKey(tok)).join(',')
            })
          }
        })
      }
      if (pop.identityTokens) {
        [...pop.identityTokens, ...pop.exactTokens, ...(pop.copyrightTokens || []), ...(pop.characterTokens || []), ...pop.aliases].forEach(tok => {
              text = text.split(',').filter(part => normalizeKey(part.replace(/\\([()])/g, '$1')) !== normalizeKey(tok)).join(',')
        })
      }
    })

    // 3. 去除通用角色前缀、LoRA 标签与衣物类描述
    text = text.replace(/<lora:[^>]+>/gi, '')
    text = text.replace(/\b(1girl|2girls|solo)\b/gi, '')
    text = text.replace(/\b(?:She wears|wearing|dressed in|outfit)\b[^,.;]*/gi, '')

    const newline = state.family === 'anima' ? text.indexOf('\n') : -1
    const caption = newline < 0 ? '' : text.slice(newline + 1)
    if (newline >= 0) text = text.slice(0, newline)

    // 4. 互斥服装族与通用衣物 Tag 清洗（彻底剥离旧服装，避免串入新角色）
    const studioKeys = new Set([
      ...Object.values(CHAR_PROMPT).flatMap(tokenize),
      ...Object.values(STUDIO_PROMPT_SUBJECTS).flatMap(subject => subject.copyrightTokens),
    ].map(normalizeKey))
    const parts = text.split(',').map(p => p.trim()).filter(part => part && !studioKeys.has(normalizeKey(part)))
    const cleanParts = parts.filter(part => {
      if (identityDomainOf(part) || mutualGroupWithCategory(part)?.category === 'outfit') return false
      const lower = part.toLowerCase()
      // 匹配明确的衣物/鞋袜/制服类 tag
      if (/^(?:[a-z0-9]+_)*(?:clothes|clothing|outfit|costume|coat|overcoat|trench_coat|jacket|dress|sundress|skirt|miniskirt|shirt|blouse|pants|trousers|jeans|shorts|hotpants|crop_top|tank_top|bodysuit|leotard|corset|bra|panties|underwear|boots|shoes|heels|sneakers|sandals|socks|tights|pantyhose|stockings|leggings|thighhighs|thigh_highs|over_knee_socks|knee_socks|uniform|serafuku|suit|robe|cloak|cape|capelet|hoodie|sweater|cardigan|vest|apron|kimono|yukata|qipao|cheongsam|swimsuit|swimwear|bikini|pajamas|sleepwear|nightgown|lingerie|gloves|scarf|necktie|belt|hat|helmet|armor|footwear|headdress)$/.test(lower)) {
        return false
      }
      return true
    })

    return state.family === 'anima' ? `${cleanParts.join(', ')}\n${caption}` : cleanParts.join(', ')
  }

  function resolveTargetCharacter(target: BatchTargetItem) {
    const charId = target.kind === 'character' ? target.characterId || target.id : blueprintList().find(item => item.id === target.id)?.characterId
    if (!charId) return null
    const popularChars = getPopularList()
    const popChar = findPopularCharacter(popularChars, charId)
    if (popChar) return { kind: 'popular' as const, char: popChar }
    if (charId === 'nene' || charId === 'natsume') {
      return { kind: 'studio' as const, charKey: charId as 'nene' | 'natsume' }
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
      const outfit = (blueprint?.outfitId ? findOutfit(pop, blueprint.outfitId) : null) || defaultOutfit(pop)
      if (!outfit) throw new Error('目标角色没有可用服装')
      const source = pb.subject.kind === 'popular' ? findPopularCharacter(getPopularList(), pb.subject.characterId) : null
      const sourceKeys = new Set([...(source?.identityTokens || []), ...(source?.exactTokens || []), ...(source?.copyrightTokens || []), ...(source?.characterTokens || []), ...(source?.aliases || []), ...(CHAR_PROMPT[pb.char] || '').split(','), ...(STUDIO_PROMPT_SUBJECTS[pb.char]?.copyrightTokens || [])].map(normalizeKey))
      const engine = state.family === 'krea2' ? 'krea2' : 'anima'
      const decisions = blueprint ? inferBlueprintDecisions(blueprint) : null
      const currentSubject = pb.subject
      const sourceBlueprint = currentSubject.kind === 'popular' && currentSubject.blueprintId
        ? pb.sceneBlueprints.find(item => item.id === currentSubject.blueprintId) : null
      const inherited = !blueprint ? null : sourceBlueprint ? inferBlueprintDecisions(sourceBlueprint)
        : currentSubject.kind === 'studio' && pb.activeScene ? sceneStyleBaseline(pb.activeScene) : null
      const shot = pb.selections.shot === inherited?.shot ? null : pb.selections.shot
      const lighting = pb.selections.lighting === inherited?.lighting ? null : pb.selections.lighting
      const composition = pb.selections.composition === inherited?.composition ? null : pb.selections.composition
      const colorMood = pb.colorMood === inherited?.colorMood ? null : pb.colorMood
      const mood = COLOR_MOODS.find(option => option.id === (colorMood ?? decisions?.colorMood))
      const inheritedNewline = target.kind === 'character' && engine === 'anima' ? baseText.indexOf('\n') : -1
      const inheritedTags = inheritedNewline < 0 ? [] : tokenize(baseText.slice(0, inheritedNewline))
      const planResult = buildPopularPromptPlan({
        character: pop, outfit, blueprint, engine, profile,
        manual: [...pb.manualTags, ...inheritedTags].filter(tag => !identityDomainOf(tag) && !sourceKeys.has(normalizeKey(tag))),
        emotion: pb.emotionPrompt ? [pb.emotionPrompt] : [],
        shot: shot ?? decisions?.shot,
        lighting: lighting ?? decisions?.lighting,
        composition: composition ?? decisions?.composition,
        palette: mood ? tokenize(mood.prompt) : [],
        visualDescription: target.kind === 'character'
          ? (inheritedNewline < 0 ? baseText : baseText.slice(inheritedNewline + 1).replace(/\s+/g, ' ')) : pb.visualDescription,
        outfitOverride: detectOutfitOverrideFromContext(),
        matureTokens: new Set(pb.tags.filter(tag => tag.cat === 'Mature').map(tag => normalizeKey(tag.en))),
        artistTags: artistTagsForEngine(pb.artistStyleIds, engine), artistProse: artistStyleProse(pb.artistStyleIds, engine),
      })
      plans.set(target.id, { negative: planResult.negative, outfitId: outfit.id, size: blueprint?.recommendedSize,
        style: { emotion: pb.emotionPrompt ? [...pb.selections.emotion] : [], shot: shot ?? decisions?.shot ?? null,
          lighting: lighting ?? decisions?.lighting ?? null, composition: composition ?? decisions?.composition ?? null, colorMood: mood?.id ?? null } })
      return planResult.prompt
    }
    if (charInfo?.kind === 'studio') {
      // 角色漫游继承已捕获的完整词条；独立蓝图只使用自己的描述。
      plans.set(target.id, { style: target.kind === 'character'
        ? { ...pb.selections, emotion: [...pb.selections.emotion], colorMood: pb.colorMood }
        : { emotion: [], shot: null, lighting: null, composition: null, colorMood: null } })
      const controls = detectOutfitOverrideFromContext() || []
      if (state.family !== 'anima') return [CHAR_PROMPT[charInfo.charKey], controls.join(', '), baseText].filter(Boolean).join(', ')
      const newline = baseText.indexOf('\n')
      const plan = createPromptPlan({
        profile, identity: CHAR_PROMPT[charInfo.charKey], ...STUDIO_PROMPT_SUBJECTS[charInfo.charKey], controls,
        artists: artistTagsForEngine(pb.artistStyleIds, 'anima'),
        scenePrompt: target.kind === 'scene' ? '' : newline < 0 ? baseText : baseText.slice(0, newline),
        sceneProse: target.kind === 'scene' ? baseText : newline < 0 ? '' : baseText.slice(newline + 1),
        exactTokens: profile?.exact_tokens,
      })
      return renderPromptPlan(plan, 'anima', profile).prompt
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
    const dimensions = /^(\d+)\s*[x×]\s*(\d+)$/.exec(plans.get(target.id)?.size || '')
    const targetState = {
      ...state,
      width: dimensions ? Number(dimensions[1]) : state.width,
      height: dimensions ? Number(dimensions[2]) : state.height,
      seed: input.seed >= 0 ? input.seed : null,
      // Cross-character roaming selects the target's installed binding; the source
      // character keeps its captured selection for the shared admission check.
      loraId: charInfo?.kind === 'studio' && (pb.subject.kind !== 'studio' || targetChar !== pb.char)
        ? ANIMA_LORA_BY_CHARACTER[charInfo.charKey] : state.loraId,
      // Batch Endfield recipes retain the collection's default strength.
      loraStrength: endfield?.loraStrength ?? state.loraStrength,
    }
    const request = buildAnimaRequest({
      subject: isTargetPopular
        ? { kind: 'popular', characterId: charInfo.char.id, outfitId: plans.get(target.id)?.outfitId || '', blueprintId: target.kind === 'scene' ? target.id : null }
        : { kind: 'studio' },
      char: targetChar, state: targetState, profile, prompt,
      negative: plans.get(target.id)?.negative ?? (state.family === 'krea2' ? '' : negativePrompt),
    })
    const history: PreparedBatchImage['history'] = {
        ...plans.get(target.id)!.style,
        seed: request.seed, negative: request.negative, prompt,
        size: `${request.width}x${request.height}`, engine: state.family === 'krea2' ? 'krea2' as const : 'anima' as const,
        model: request.modelId, profile: request.profileId, loraId: request.loraId, loraStrength: request.loraStrength,
        lora: request.loraId, noLora: !request.loraId, styleLoraId: request.styleLoraId ?? null,
        cfg: request.cfg, steps: request.steps, sampler: state.sampler, scheduler: state.scheduler,
        visualDescription: pb.visualDescription, manual_tags: [...pb.manualTags], artistStyleIds: [...pb.artistStyleIds], project: pb.projectId,
        // 精准覆盖角色元数据
        ...(isTargetPopular ? {
          subject: 'popular' as const,
          characterId: charInfo.char.id,
          outfitId: plans.get(target.id)?.outfitId || defaultOutfit(charInfo.char)?.id,
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
      adult: blueprintList().find(item => item.id === target.id)?.adult === true,
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
      return {
        id,
        title: blueprint?.title || id,
        prose: batchSceneProse(blueprint),
        subtitle: blueprint?.location || blueprint?.category,
        kind: 'scene' as const,
      }
    }).filter(item => item.prose)
  }

  function characterTargets(ids: string[], rawPrompt: string): BatchTargetItem[] {
    const basePrompt = extractUniversalPrompt(rawPrompt)
    const popularChars = getPopularList()

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
