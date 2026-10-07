import { computed, type Ref } from 'vue'
import type { ShowcaseEntry, ShowcaseEntryType } from '@/utils/showcaseManifest'
import type { PopularCharacter } from '@/types/character'
import { franchiseKey, franchiseLabel } from '@/utils/franchiseLabel'

export interface ShowcaseAlbum {
  id: string
  group: 'overview' | 'theme' | 'franchise'
  type: ShowcaseEntryType
  title: string
  description: string
  count: number
  covers: ShowcaseEntry[]
  entryIds: string[]
}

const ALBUMS: Pick<ShowcaseAlbum, 'type' | 'title' | 'description'>[] = [
  { type: 'scene', title: '场景故事', description: '把喜欢的一幕留在画中' },
  { type: 'popular', title: '角色印象', description: '与熟悉的面孔再次相遇' },
  { type: 'artist', title: '画师风格', description: '翻阅不同笔触里的光与色' },
  { type: 'lora', title: 'LoRA 样张', description: '寻找适合这次创作的表现' },
]
const SCENE_THEMES = ['校园', '日常', '恋爱', '旅行', '祭典・节日', '亲密', '官方CG灵感', '战斗']
type AlbumCharacter = Pick<PopularCharacter, 'id' | 'franchise'>

function collection(id: string, group: ShowcaseAlbum['group'], album: Pick<ShowcaseAlbum, 'type' | 'title' | 'description'>, members: readonly ShowcaseEntry[]): ShowcaseAlbum {
  return { ...album, id, group, count: members.length, entryIds: members.map(entry => entry.id),
    covers: members.filter(entry => entry.rating === 'All').slice(0, 3) }
}

/** 只从已加载的受控展示目录派生；相册封面不提升任何条目的浏览权限。 */
export function buildShowcaseAlbums(entries: readonly ShowcaseEntry[], characters: readonly AlbumCharacter[] = []): ShowcaseAlbum[] {
  const overview = ALBUMS.flatMap(album => {
    const members = entries.filter(entry => entry.type === album.type)
    if (!members.length) return []
    return [collection(album.type, 'overview', album, members)]
  })
  const themes = SCENE_THEMES.flatMap(theme => {
    const members = entries.filter(entry => entry.type === 'scene' && entry.category.split('/')[0].replace('日常生活', '日常') === theme)
    return members.length ? [collection(`theme:${theme}`, 'theme', { type: 'scene', title: theme, description: '场景主题' }, members)] : []
  })
  const sources = new Map(characters.map(character => [character.id, franchiseKey(character.franchise)]))
  const series = new Map<string, ShowcaseEntry[]>()
  for (const entry of entries) {
    const source = sources.get(entry.char)
    if (entry.type !== 'popular' || !source) continue
    const members = series.get(source) ?? []
    members.push(entry); series.set(source, members)
  }
  const franchises = [...series].map(([source, members]) => collection(`franchise:${source}`, 'franchise', {
    type: 'popular', title: franchiseLabel(source), description: `${new Set(members.map(entry => entry.char)).size} 位角色 · 作品系列`,
  }, members)).sort((a, b) => b.count - a.count || a.title.localeCompare(b.title, 'zh-CN'))
  return [...overview, ...themes, ...franchises]
}

export function useShowcaseAlbums(entries: Readonly<Ref<ShowcaseEntry[]>>, characters: () => readonly AlbumCharacter[] = () => []) {
  return computed(() => buildShowcaseAlbums(entries.value, characters()))
}
