import { ref } from 'vue'
import { profileDraftStorage, flushProfileWrites } from '@/platform/web/profileStorage'
import { decodeVideoDraft } from './videoDraftCodec'
import { getDesktopRuntime } from '@/platform/desktop/runtime'

function owner() {
  const bootstrap = getDesktopRuntime().bootstrap
  const workspace = bootstrap?.runtime?.workspace
  return JSON.stringify([location.origin, bootstrap?.sourceProfileId, workspace?.workspaceId, workspace?.principalId])
}

export function createVideoDraftStorage() {
  const issues = ref<Record<string, string>>({})
  const originals = new Map<string, string>()
  const owners = new Map<string, string>()
  const deletions = new Set<string>()
  function read<T>(key: string, decode: (value: unknown) => T): T | null {
    let raw: string | null = null
    try {
      if (deletions.has(key)) throw new Error('清除回执尚未确认，请重试清除')
      raw = profileDraftStorage.getItem(key)
      const value = raw === null ? null : decodeVideoDraft(raw, decode)
      delete issues.value[key]; originals.delete(key); owners.delete(key)
      return value
    } catch (error) {
      if (raw !== null) { originals.set(key, raw); owners.set(key, owner()) }
      issues.value[key] = error instanceof Error ? error.message : '草稿读取失败'
      return null
    }
  }
  function write<T>(key: string, value: unknown, decode: (value: unknown) => T): T | null {
    if (issues.value[key]) return null
    try {
      const snapshot = decode(value)
      profileDraftStorage.setItem(key, JSON.stringify(Array.isArray(snapshot) ? snapshot : { ...snapshot, _videoDraftVersion: 1 }))
      return snapshot
    } catch { return null }
  }
  async function discard() {
    // Only explicitly selected damaged records are removed. Keep original bytes
    // in memory until the deletion acknowledgement arrives.
    const keys = Object.keys(issues.value)
    for (const key of keys) {
      if (!originals.has(key) || owners.get(key) !== owner()) throw new Error('无法确认原草稿所属工作区，请重新读取')
      if (!deletions.has(key) && profileDraftStorage.getItem(key) !== originals.get(key)) throw new Error('草稿已变化，请重新读取后再决定')
    }
    for (const key of keys) {
      if (deletions.has(key)) continue
      profileDraftStorage.removeItem(key)
      deletions.add(key)
    }
    await flushProfileWrites()
    for (const key of keys) {
      if (owners.get(key) !== owner()) throw new Error('工作区已变化，请回到原工作区确认清除')
      delete issues.value[key]; originals.delete(key); owners.delete(key); deletions.delete(key)
    }
  }
  function exportOriginals() {
    return new Blob([JSON.stringify({ format: 'huiyu-video-draft-recovery', records: Object.fromEntries(originals) }, null, 2)], { type: 'application/json' })
  }
  return { issues, read, write, discard, exportOriginals }
}
