import { shallowRef } from 'vue'

export interface CharacterReferenceItem {
  id: string
  name: string
  shotType: string
  fileName: string
  lens: string
  targetUsage: string[]
  url: string
  pending?: boolean
}

export interface CharacterOutfitReference {
  outfitId: string
  outfitName: string
  isDefault: boolean
  isNsfw: boolean
  prose: string
  references: CharacterReferenceItem[]
}

export interface CharacterReferenceProfile {
  characterId: string
  displayName: string
  source: string
  identityProse: string
  outfits: CharacterOutfitReference[]
}

/** 按角色懒加载；网关保留本机权限并选择已安装的参考资源版本。 */
const standards = shallowRef<Record<string, CharacterReferenceProfile>>({})
const requests = new Map<string, Promise<void>>()
const revisions = new Map<string, number>()

/** 同一角色并发去重；失败可重试，刷新前的迟到响应不会覆盖新数据。 */
export function ensureCharacterReferencesLoaded(characterId: string, refresh = false): Promise<void> {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(characterId)) return Promise.reject(new Error('角色 ID 无效'))
  if (!refresh && requests.has(characterId)) return requests.get(characterId)!
  const revision = (revisions.get(characterId) || 0) + 1
  revisions.set(characterId, revision)
  const request = fetch('/api/character-reference-profile/' + encodeURIComponent(characterId), { cache: 'no-cache' })
    .then(async response => {
      if (response.status === 404) return undefined
      if (!response.ok) throw new Error('character-reference-profile ' + response.status)
      const data = await response.json() as CharacterReferenceProfile
      if (!data || data.characterId !== characterId || !Array.isArray(data.outfits)) throw new Error('参考档案格式无效')
      return data
    })
    .then(data => {
      if (revisions.get(characterId) !== revision) return
      const next = { ...standards.value }
      if (data) next[characterId] = data
      else delete next[characterId]
      standards.value = next
    })
    .catch(error => {
      if (revisions.get(characterId) === revision) requests.delete(characterId)
      throw error
    })
  requests.set(characterId, request)
  return request
}

/** 同步读取角色参考档案；数据未加载完成时返回 undefined（与未知角色同路径降级）。 */
export function getCharacterReferences(characterId: string): CharacterReferenceProfile | undefined {
  return standards.value[characterId]
}
