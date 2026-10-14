import { executeCompanionTool } from '@/api/companionToolsApi'
import { isCompanionDrawingPath, parseCompanionDrawingDraft } from '@/types/companionDrawing'
import { defaultOutfit, findCharacter, findOutfit } from '@/utils/popularContent'
import type { PromptDeepLinkDeps } from './usePromptDeepLink'

/** Read the saved source before changing the editor; the normal compiler owns
 * model/profile/LoRA selection. Legacy draft promptTokens are never imported. */
export async function applyCompanionDraft(path: string, deps: PromptDeepLinkDeps, isCurrent: () => boolean): Promise<void> {
  const { pb } = deps
  try {
    if (!isCompanionDrawingPath(path)) throw new Error('绘画草稿引用无效。')
    const result = await executeCompanionTool('read_file', { path }, AbortSignal.timeout(10_000))
    if (!isCurrent()) return
    if (!result.ok) throw new Error(result.output)
    const value: unknown = JSON.parse(result.output)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('绘画草稿内容无效。')
    const draft = value as Record<string, unknown>
    const reference = parseCompanionDrawingDraft({ path, character: draft.character, description: draft.description })
    const visual = typeof draft.visualDescription === 'string' ? draft.visualDescription : draft.description
    if (!reference || draft.status !== 'draft' || typeof visual !== 'string' || !visual.trim() || /[^\x00-\x7F]/.test(visual) || visual.length > 8000) {
      throw new Error('草稿缺少有效的英文画面描述，请在聊天中重新准备草稿；原文件已保留。')
    }
    const outfit = typeof draft.outfit === 'string' ? draft.outfit.trim() : 'default'
    if (outfit.length > 100) throw new Error('草稿服装字段无效。')
    const mature = draft.mature === true || outfit === 'nsfw_nude'
    const studio = reference.character === 'nene' || reference.character === 'natsume'
    if (!studio) await pb.loadPopularCharacter(reference.character)
    if (!isCurrent()) return
    const character = studio ? null : findCharacter(pb.popularCharacters, reference.character)
    if (!studio && !character) throw new Error('这个本机陪伴角色尚未绑定工作台角色，草稿已保留，请先在工作台选择对应角色。')
    const catalogOutfit = character ? findOutfit(character, outfit) || character.outfits.find(item => item.name === outfit) || defaultOutfit(character) : null
    if (studio) deps.selectPopularSource('studio')
    else deps.selectPopularSource('popular')
    pb.clearScene()
    if (studio) pb.setChar(reference.character as 'nene' | 'natsume')
    else if (character && catalogOutfit) {
      pb.setPopularSubject(character.id, catalogOutfit.id, null)
      deps.applyRecommendedEngine(character)
    }
    pb.setStory(reference.description)
    pb.visualDescription = visual.trim()
    pb.sdParams.negativeCustom = ''
    pb.setArtistStyleIds([])
    if (outfit && outfit !== 'default' && (!character || catalogOutfit?.id !== outfit && catalogOutfit?.name !== outfit)) {
      const token = outfit === 'nsfw_nude' ? 'nude' : outfit
      if (character) pb.setOutfitOverride([token], catalogOutfit?.name || null)
      else pb.manualTags = new Set([token])
    }
    if (mature) pb.manualTags = new Set([...pb.manualTags, 'nsfw'])
    pb.flash('已载入桌宠绘画草稿，请核对角色、服装与画面描述，再点击生成。')
  } catch (error) { if (isCurrent()) pb.flash(error instanceof Error ? error.message : '绘画草稿读取失败；原文件与当前编辑已保留。') }
}
