import { readChatPreferences } from '@/storage/chatPreferences'
import { getCompanionCharacterConfig } from '@/utils/companionRegistry'
import { profileLocalStorage, profileRuntimeActive } from '@/platform/web/profileStorage'

export function savedCompanionCharacter() {
  try {
    const selected = readChatPreferences()?.active
    if (selected) return selected
    // Older profiles kept the selection alongside their chat records.
    if (!profileRuntimeActive()) {
      const active = JSON.parse(profileLocalStorage.getItem('aics_chat_v1') || 'null')?.active
      if (typeof active === 'string') return active
    }
  } catch { /* The room can report unreadable legacy history when it opens. */ }
  return ''
}

export async function loadActiveCompanion() {
  const id = savedCompanionCharacter()
  if (!id || getCompanionCharacterConfig(id)) return
  if (id.startsWith('card-')) {
    const { loadChatCard } = await import('@/utils/chatCards')
    await loadChatCard(id)
  } else {
    const { loadLocalCompanions } = await import('@/utils/localCompanions')
    await loadLocalCompanions(id)
  }
}

export async function loadCompanionDirectory() {
  await Promise.all([
    import('@/utils/localCompanions').then(module => module.loadLocalCompanions()),
    import('@/utils/chatCards').then(module => module.loadChatCards()),
  ])
}
