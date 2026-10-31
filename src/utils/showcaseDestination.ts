import { canonicalShowcaseId, catalogShowcaseId, type ShowcaseEntry } from './showcaseManifest'

/** Resolve only identities known to the current catalog; never guess a blueprint from an image title. */
export function showcaseDestination(entry: ShowcaseEntry, characters: ReadonlyArray<{ id: string }>, blueprints: ReadonlyArray<{ id: string; characterId?: string }>) {
  if (entry.type === 'scene') return { to: '/prompt-builder?scene=' + encodeURIComponent(entry.id) + '&step=4', label: '在工作台打开', hint: '载入场景后可调整，不会自动生成。' }
  if (entry.type === 'popular' && characters.some(character => character.id === entry.char)) {
    const id = canonicalShowcaseId(entry)
    const blueprint = blueprints.find(item => item.characterId === entry.char
      && id === catalogShowcaseId({ kind: 'blueprint', characterId: entry.char, id: item.id }))
    return { to: '/prompt-builder?popular=' + encodeURIComponent(entry.char) + (blueprint ? '&blueprint=' + encodeURIComponent(blueprint.id) : ''), label: blueprint ? '使用这个角色场景' : '打开角色工作台', hint: blueprint ? '载入角色与场景，不会自动生成。' : '这张样图没有对应的当前场景，仅载入角色。' }
  }
  if (entry.type === 'artist') return { to: '/style', label: '查看画风设置', hint: '先选择画风，再开始创作。' }
  if (entry.type === 'lora') return { to: '/lora', label: '查看模型设置', hint: '查看模型和推荐设置。' }
  return { to: '/popular-scenes', label: '查找角色场景', hint: '当前角色目录中未找到这张样图的角色。' }
}
