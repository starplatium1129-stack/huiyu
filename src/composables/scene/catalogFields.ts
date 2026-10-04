import type { CatalogKind, CatalogRecord } from '@/api/catalogApi'
export interface CatalogField { path: string; label: string; type?: 'list' | 'boolean' | 'long'; section: string }
const fields = (section: string, entries: Array<[string, string, CatalogField['type']?]>): CatalogField[] => entries.map(([path, label, type]) => ({ path, label, type, section }))
export const CATALOG_FIELDS: Record<CatalogKind, CatalogField[]> = {
  character: [
    ...fields('人物档案', [['profile.name', '名称'], ['profile.alias', '别名', 'list'], ['profile.source', '来源'], ['profile.bg_story', '背景', 'long'], ['profile.personality', '性格', 'list'], ['profile.accent_color', '强调色'], ['profile.portrait', '立绘地址']]),
    ...fields('视觉设定', [['profile.visual_dna.hair', '头发'], ['profile.visual_dna.hair_color', '发色'], ['profile.visual_dna.eyes', '眼睛'], ['profile.visual_dna.hairstyle', '发型'], ['profile.visual_dna.uniform', '服装设定'], ['profile.visual_dna.expression', '表情'], ['profile.visual_dna.style', '绘画特征'], ['profile.visual_dna.signature', '识别特征']]),
    ...fields('提示词身份', [['popular.displayName', '显示名称'], ['popular.originalName', '原名'], ['popular.franchise', '系列'], ['popular.recommendedEngine', '常用绘图方式'], ['popular.supportedEngines', '可用绘图方式', 'list'], ['popular.adultEligibility', '年龄确认'], ['popular.aliases', '搜索别名', 'list'], ['popular.identityProse', '人物描述', 'long'], ['popular.identityTokens', '人物特征关键词', 'list'], ['popular.negativeTokens', '需要避免的特征', 'list'], ['popular.exactTokens', '匹配词条', 'list'], ['popular.exactPrefixes', '匹配前缀', 'list']]),
  ],
  outfit: [
    ...fields('服装绑定', [['characterId', '所属角色'], ['outfit.id', '服装代号'], ['outfit.name', '名称'], ['outfit.default', '默认服装', 'boolean']]),
    ...fields('服装内容', [['outfit.prose', '服装描述', 'long'], ['outfit.tokens', '服装词条', 'list']]),
  ],
  scene: [
    ...fields('基础信息', [['title', '标题'], ['category', '分类'], ['char', '所属角色'], ['outfitId', '服装代号'], ['rating', '分级'], ['mature', '成人内容', 'boolean'], ['story', '故事', 'long'], ['storyJa', '日文故事', 'long']]),
    ...fields('场景事实', [['location', '地点'], ['timeOfDay', '时段'], ['weather', '天气'], ['lighting', '光照'], ['camera', '镜头'], ['emotion', '情绪'], ['tags', '标签', 'list'], ['recommendedSize', '尺寸']]),
    ...fields('引擎提示词', [['prompt', '画面描述', 'long'], ['negative', '避免出现的内容', 'long'], ['animaCaption', '补充画面描述', 'long']]),
  ],
  blueprint: [
    ...fields('基础信息', [['title', '标题'], ['category', '分类'], ['characterId', '所属角色'], ['outfitId', '服装代号'], ['sampleRating', '样张分级'], ['adult', '成人蓝图', 'boolean'], ['description', '说明', 'long']]),
    ...fields('场景事实', [['location', '地点'], ['action', '动作', 'long'], ['timeOfDay', '时段'], ['lighting', '光照'], ['camera', '镜头'], ['mood', '情绪'], ['sceneTags', '场景标签', 'list'], ['recommendedSize', '尺寸'], ['compositionIntent', '构图']]),
    ...fields('引擎提示词', [['promptProse', '画面描述', 'long'], ['promptTokens', '画面关键词', 'list'], ['negativeTokens', '避免出现的内容', 'list'], ['nsfwProse', '扩展描述', 'long'], ['nsfwTokens', '扩展词条', 'list'], ['coverageTags', '服装覆盖范围', 'list']]),
  ],
  document: [],
}
export function fieldValue(data: CatalogRecord['data'], path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, data)
}
export function setField(data: CatalogRecord['data'], field: CatalogField, input: string | boolean) {
  const segments = field.path.split('.'), key = segments.pop()!
  let target = data as Record<string, unknown>
  for (const segment of segments) {
    if (!target[segment] || typeof target[segment] !== 'object') target[segment] = {}
    target = target[segment] as Record<string, unknown>
  }
  target[key] = field.type === 'list' ? String(input).split('\n').map(v => v.trim()).filter(Boolean) : input
}
export function blankRecord(kind: CatalogKind): CatalogRecord {
  const data: Record<string, unknown> = kind === 'character' ? { id: '', profile: { id: '', name: '' } }
    : kind === 'outfit' ? { characterId: '', outfit: { id: '', name: '', default: false, prose: '', tokens: [] } }
      : kind === 'blueprint' ? { id: '', title: '', characterId: '', category: '', description: '', promptProse: '', promptTokens: [], negativeTokens: [], adult: false, sampleRating: 'All' }
        : { id: '', title: '', char: 'nene', character: '宁宁', category: 'custom', story: '', storyJa: '', rating: 'All', mature: false, tags: [], prompt: '', negative: '', animaCaption: '' }
  return { kind, id: '', revision: 0, sortOrder: 0, createdAt: null, updatedAt: null, data }
}
