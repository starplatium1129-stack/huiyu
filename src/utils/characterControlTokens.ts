import type { PromptScene } from './sceneFraming.ts'
import { normalizeKey, sceneRating } from './promptPrimitives.ts'

import { TRAINED_OUTFIT_BUNDLES } from './canonicalOutfits.ts'
export { TRAINED_OUTFIT_BUNDLES } from './canonicalOutfits.ts'

function appendOutfitBundle(controls: string[], bundle: readonly string[]): void {
  controls.push(...bundle)
}

/**
 * 新一代统一角色 LoRA 的显式控制词。成人内容、官方服装都必须由场景
 * 明确触发，不能仅依赖训练集中的共现关系；旧模型不会收到未学习的新词。
 */
export function characterControlTokens(
  scene: PromptScene | null | undefined,
  character: string,
  activeLoras: Record<string, string> = {},
): string[] {
  if (!scene) return []
  // Search/display tags are metadata, not authored model instructions.
  const source = normalizeKey(scene.prompt || '')
  const controls: string[] = []
  const includesNene = character === 'nene' || character === 'triad'
  const includesNatsume = character === 'natsume' || character === 'triad'
  const neneSupportsControls = /ayachi_nene_v(?:18|19|[2-9]\d)/i.test(activeLoras.nene || '')
    || /^L_NENE_V(?:18|19|[2-9]\d)/i.test(activeLoras.nene || '')
  const natsumeSupportsControls = /shiki_natsume_v(?:17|18|19|[2-9]\d)/i.test(activeLoras.natsume || '')
    || /^L_NAT_V(?:17|18|19|[2-9]\d)/i.test(activeLoras.natsume || '')

  if (includesNene && neneSupportsControls) {
    if (sceneRating(scene) === 'R18') controls.push('nene_r18')
    if (/(?:nene_witch_canonical|official(?:_ayachi_nene)?_witch|witch_costume)/.test(source)) {
      appendOutfitBundle(controls, TRAINED_OUTFIT_BUNDLES.neneWitch)
    } else if (/(?:nene_sailor_uniform|grey_sailor_collar|sailor_shirt|serafuku)/.test(source)) {
      appendOutfitBundle(controls, TRAINED_OUTFIT_BUNDLES.neneSailor)
    } else if (/(?:nene_red_cardigan_uniform|open_burgundy_cardigan|red_cardigan_uniform)/.test(source)) {
      appendOutfitBundle(controls, TRAINED_OUTFIT_BUNDLES.neneRedCardigan)
    } else if (/(?:nene_blue_pajamas|sky_blue_patterned_button_up_pajama|cat_print)/.test(source)) {
      appendOutfitBundle(controls, TRAINED_OUTFIT_BUNDLES.neneBluePajamas)
    } else if (/(?:nene_green_sleepwear|mint_green_polka_dot_pajama)/.test(source)) {
      appendOutfitBundle(controls, TRAINED_OUTFIT_BUNDLES.neneGreenSleepwear)
    } else if (/(?:nene_bat_dress|bat_hair_ornament)/.test(source)) {
      appendOutfitBundle(controls, TRAINED_OUTFIT_BUNDLES.neneBatDress)
    } else if (/(?:nene_black_dress)/.test(source)) {
      appendOutfitBundle(controls, TRAINED_OUTFIT_BUNDLES.neneBlackDress)
    } else if (
      /(?:nene_school_uniform|navy_school_uniform|complete_navy_school_uniform)/.test(source)
      || (/(?:school_uniform|navy_blazer)/.test(source) && !/(?:magenta|red_cardigan)/.test(source))
    ) {
      appendOutfitBundle(controls, TRAINED_OUTFIT_BUNDLES.neneSchool)
    }
  }

  if (includesNatsume && natsumeSupportsControls) {
    if (sceneRating(scene) === 'R18') controls.push('natsume_r18')
    if (/(?:natsume_official_qipao|qipao|cheongsam|china_dress)/.test(source)) {
      appendOutfitBundle(controls, TRAINED_OUTFIT_BUNDLES.natsumeQipao)
    } else if (/(?:natsume_pink_cafe_uniform|pink_cafe_uniform)/.test(source)) {
      appendOutfitBundle(controls, TRAINED_OUTFIT_BUNDLES.natsumePinkCafe)
    } else if (/(?:natsume_maid_uniform|dark_gray_cafe_maid_dress|maid_uniform)/.test(source)) {
      appendOutfitBundle(controls, TRAINED_OUTFIT_BUNDLES.natsumeMaid)
    } else if (/(?:natsume_cafe_uniform|cafe_uniform|suspender_skirt|dark_brown_suspender_skirt)/.test(source)) {
      appendOutfitBundle(controls, TRAINED_OUTFIT_BUNDLES.natsumeCafe)
    } else if (/(?:natsume_winter_coat)/.test(source)) {
      appendOutfitBundle(controls, TRAINED_OUTFIT_BUNDLES.natsumeWinter)
    } else if (/(?:natsume_sleepwear|pale_blue_pajamas_with_red_piping)/.test(source)) {
      appendOutfitBundle(controls, TRAINED_OUTFIT_BUNDLES.natsumeSleepwear)
    }
  }
  return [...new Set(controls)]
}
