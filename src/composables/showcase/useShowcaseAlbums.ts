import { computed, type Ref } from 'vue'
import type { ShowcaseEntry, ShowcaseEntryType } from '@/utils/showcaseManifest'

export interface ShowcaseAlbum {
  type: ShowcaseEntryType
  title: string
  description: string
  count: number
  cover: ShowcaseEntry | null
}

const ALBUMS: Pick<ShowcaseAlbum, 'type' | 'title' | 'description'>[] = [
  { type: 'scene', title: '场景故事', description: '把喜欢的一幕留在画中' },
  { type: 'popular', title: '角色印象', description: '与熟悉的面孔再次相遇' },
  { type: 'artist', title: '画师风格', description: '翻阅不同笔触里的光与色' },
  { type: 'lora', title: 'LoRA 样张', description: '寻找适合这次创作的表现' },
]

/** 只从已加载的受控展示目录派生；相册封面不提升任何条目的浏览权限。 */
export function buildShowcaseAlbums(entries: readonly ShowcaseEntry[]): ShowcaseAlbum[] {
  return ALBUMS.flatMap(album => {
    const members = entries.filter(entry => entry.type === album.type)
    if (!members.length) return []
    return [{ ...album, count: members.length, cover: members.find(entry => entry.rating === 'All') ?? null }]
  })
}

export function useShowcaseAlbums(entries: Readonly<Ref<ShowcaseEntry[]>>) {
  return computed(() => buildShowcaseAlbums(entries.value))
}
