import type { DrawCapabilities } from './promptPolicyTypes'
import { QUALITY_OR_SCORE_RE } from './promptDiagnostics'
import { tagKey } from './animaPromptOrder'
import { splitBreaks, tokenize } from './promptPrimitives'

export interface PromptPreviewContext {
  format: DrawCapabilities['promptFormat']
  characterTokens: readonly string[]
  copyrightTokens: readonly string[]
  qualityTokens: readonly string[]
  artists: readonly string[]
}

type LayerId = 'quality' | 'identity' | 'artist' | 'visual' | 'prose'
interface PreviewGroup { label?: string; tokens: string[] }
export interface PromptPreviewLayer {
  id: LayerId
  number: string
  label: string
  empty: string
  groups: PreviewGroup[]
  prose?: string
}

/** Display the actual compiled text. Metadata classifies only tokens already
 * present; preview grouping never adds, reformats or reorders the sent prompt. */
export function promptPreviewScopes(positive: string, context: PromptPreviewContext): PromptPreviewLayer[][] {
  if (context.format === 'natural-language') return [[{
    id:'prose', number:'01', label:'画面描述', empty:'尚未添加画面描述', groups:[], prose:positive,
  }]]
  const [tagLine = '', ...caption] = positive.split('\n')
  const characters = new Set(context.characterTokens.map(tagKey))
  const copyrights = new Set(context.copyrightTokens.map(tagKey))
  const artists = new Set(context.artists.flatMap(tokenize).map(tagKey))
  const quality = new Set(context.qualityTokens.map(tagKey))
  const scopes = splitBreaks(tagLine)
  return scopes.map((scope, scopeIndex): PromptPreviewLayer[] => {
    const qualityTags: string[] = [], characterTags: string[] = [], copyrightTags: string[] = []
    const artistTags: string[] = [], visualTags: string[] = []
    for (const token of tokenize(scope)) {
      const key = tagKey(token)
      if (quality.has(key) || QUALITY_OR_SCORE_RE.test(key.replace(/ /g,'_'))
        || /^(?:safe|general|sensitive|questionable|explicit|nsfw|r[\s_-]?(?:18|15))$/i.test(key)) qualityTags.push(token)
      else if (/^(?:\d+\+?(?:girls?|boys?|others?|people)|solo|multiple girls|multiple boys|no humans)$/.test(key)
        || characters.has(key)) characterTags.push(token)
      else if (copyrights.has(key)) copyrightTags.push(token)
      else if (artists.has(key) || key.startsWith('@')) artistTags.push(token)
      else visualTags.push(token)
    }
    return [
      { id:'quality', number:'01', label:'质量 / 分级', empty:'未使用', groups:[{ tokens:qualityTags }] },
      { id:'identity', number:'02', label:'角色与作品', empty:'未指定', groups:[
        { label:'角色', tokens:characterTags }, { label:'作品', tokens:copyrightTags },
      ] },
      { id:'artist', number:'03', label:'画师', empty:'未选择画师', groups:[{ tokens:artistTags }] },
      { id:'visual', number:'04', label:'画面标签', empty:'待添加', groups:[{ tokens:visualTags }] },
      { id:'prose', number:'05', label:'自然语言', empty:'可按需补充', groups:[],
        prose:scopeIndex === scopes.length - 1 ? caption.join('\n').trim() : '' },
    ]
  })
}
