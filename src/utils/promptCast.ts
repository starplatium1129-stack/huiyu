import type { InterrogateAssistLayout } from '../types/interrogate'
import type { CastFormation, CastMember } from '../types/prompt'
import { tagKey } from './animaPromptOrder.ts'
import { isRecord } from './popularParseGuards.ts'
import { splitBreaks, tokenize } from './promptPrimitives.ts'

export function parseCastMember(value: unknown): CastMember | null {
  if (!isRecord(value) || (value.source !== 'studio' && value.source !== 'popular')
    || typeof value.characterId !== 'string' || !value.characterId.trim()
    || typeof value.outfitId !== 'string') return null
  const characterId = value.characterId.trim()
  if (value.source === 'studio' && characterId !== 'nene' && characterId !== 'natsume') return null
  const action = typeof value.action === 'string' ? value.action.replace(/[\r\n]+/g, ' ').trim().slice(0, 240) : ''
  return {
    source: value.source, characterId, outfitId: value.outfitId.trim(),
    ...(typeof value.outfitExplicit === 'boolean' ? { outfitExplicit: value.outfitExplicit } : {}),
    ...(action ? { action } : {}),
  }
}

export function castMemberKey(member: CastMember): string {
  return `${member.source}:${member.characterId}`
}

export function parseCastMembers(value: unknown): CastMember[] {
  if (!Array.isArray(value)) return []
  const members = new Map<string, CastMember>()
  for (const item of value) {
    const member = parseCastMember(item)
    if (member && !members.has(castMemberKey(member))) members.set(castMemberKey(member), member)
    if (members.size === 4) break
  }
  return [...members.values()]
}

export function parseCastFormation(value: unknown): CastFormation | undefined {
  return value === 'row' || value === 'staggered' ? value : undefined
}

export function parseLeadPosition(value: unknown, companions: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? Math.max(0, Math.min(value, companions)) : 0
}

export function referenceCharacterCount(layout: InterrogateAssistLayout | null | undefined): number {
  return layout?.items.filter(item => item.label === 'character').length ?? 0
}

export function isCastCountTag(token: string): boolean {
  return /^(?:\d+\+?\s*(?:girls?|boys?|people|persons?|women|woman|men|man|others?|subjects?|characters?)|solo(?: focus)?|single (?:subject|character|person|figure)|only (?:one )?(?:subject|character|person|figure)|multiple (?:girls|boys|people|subjects|characters)|no humans|duo|trio|two shot|threesome|couple proximity framing)$/.test(tagKey(token))
}

export function cleanCastProse(value: string): string {
  return value
    .replace(/<lora:[^>]*>|\b(?:nene|natsume)_[a-z\d_]+\b/gi, '')
    .replace(/\bis the only (?:prominent |visible )?(?:character|subject|person|figure),?\s*/gi, 'is ')
    .replace(/,?\s+the only (?:prominent |visible )?(?:character|subject|person|figure) in the (?:image|frame|shot)\b,?/gi, ',')
    .replace(/\b(?:the )?(?:only one|a single|a lone|the sole)\s+(?=(?:subject|character|person|figure|girl|boy|woman|man)\b)/gi, 'the ')
    .replace(/\b(?:there (?:is|are) )?(?:no (?:other|second)|without (?:another|a second)) (?:person|people|subject|character|figure)(?:s)?(?: (?:is |are )?(?:visible|present|in (?:the )?(?:frame|shot)))?\b/gi, '')
    .replace(/\b(?:solo(?:[ _]focus)?|single[ _](?:subject|character|person|figure)|\d+[ _]?(?:girls?|boys?)|(?:alone|by (?:her|him|them)self) in (?:the )?(?:frame|shot))\b/gi, '')
    .replace(/(?:画面中|镜头里)?(?:只有|仅有)?(?:单人构图|单人入镜|单人镜头)/g, '')
    .replace(/[ ,]+(?=[.!?])/g, '').replace(/\s{2,}/g, ' ').replace(/^[,;\s]+|[,;\s]+$/g, '')
}

export function cleanCastNegative(value: string): string {
  return splitBreaks(value).map(section => tokenize(section).filter(token => {
    const key = tagKey(token)
    return !isCastCountTag(token) && !/^(?:(?:multiple|second|third|extra|additional|another|two|three|four|five|\d+\+?) (?:visible )?(?:characters?|subjects?|persons?|figures?|people|girls?|boys?|women|woman|men|man)|group (?:shot|portrait|photo)|crowd|duo|trio|more than (?:one|1) (?:persons?|figures?|characters?|girls?|boys?))$/.test(key)
  }).join(', ')).filter(Boolean).join(' BREAK ')
}
