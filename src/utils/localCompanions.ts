import { runtimeFetch } from '../platform/runtimeUrl.ts'
import { isLocalStudioHost } from './runtimeEnvironment.ts'
import { registerCompanionAvatar, registerCompanionCharacter, type CompanionAvatarDefinition, type CompanionCharacterDefinition } from './companionRegistry.ts'
import { validateAdapterProfile, type Live2DAdapterProfile } from '../live2d/adapterProfile.ts'

let loaded: Promise<void> | undefined

/** Load before room setup captures its character list. Remote sessions keep builtins only. */
export function loadLocalCompanions(): Promise<void> {
  if (!isLocalStudioHost()) return Promise.resolve()
  if (loaded) return loaded
  let current: Promise<void>
  current = (async () => {
    const response = await runtimeFetch('/api/live2d-companions', { signal: AbortSignal.timeout(5000) })
    if (!response.ok) throw new Error(`本机角色目录 HTTP ${response.status}`)
    const entries: unknown = await response.json()
    if (!Array.isArray(entries)) throw new Error('本机角色目录格式无效')
    for (const value of entries) {
      const entry = value as { character: CompanionCharacterDefinition; avatar: CompanionAvatarDefinition; profile: Live2DAdapterProfile }
      if (!entry.character || ['nene', 'natsume'].includes(entry.character.id)
        || entry.avatar?.characterId !== entry.character.id
        || entry.character.defaultAvatarId !== entry.avatar.id
        || entry.avatar.profileId !== entry.profile?.profileId || entry.profile.avatarId !== entry.avatar.id
        || !entry.avatar.modelPath.startsWith(`/api/live2d-local/${entry.character.id}/`)
        || !validateAdapterProfile(entry.profile).valid) continue
      registerCompanionCharacter(entry.character)
      registerCompanionAvatar(entry.avatar, entry.profile)
    }
  })().catch((error) => {
    if (loaded === current) loaded = undefined
    console.warn('本机 Live2D 角色目录暂不可用', error)
  })
  loaded = current
  return current
}
