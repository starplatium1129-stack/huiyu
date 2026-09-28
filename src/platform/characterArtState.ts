import { readonly, shallowRef } from 'vue'
import { isLocalStudioHost } from '../utils/runtimeEnvironment.ts'

export interface CharacterArtEntry {
  revision: string
  portraitUrl: string
  thumbnailUrl: string
  particleUrl: string
  width: number
  height: number
  hasTransparency: boolean
  sourceSha256?: string
}
export interface CharacterArtManifest { version: string; entries: Record<string, CharacterArtEntry> }
const manifest = shallowRef<CharacterArtManifest>({ version: '0', entries: {} })
export const characterArtManifest = readonly(manifest)
export function adoptCharacterArtManifest(value: CharacterArtManifest): void {
  const copy = isLocalStudioHost() ? structuredClone(value) : { version: '0', entries: {} }
  Object.values(copy.entries).forEach(Object.freeze)
  Object.freeze(copy.entries)
  manifest.value = Object.freeze(copy)
}
export function clearCharacterArtManifest(): void { manifest.value = { version: '0', entries: {} } }
export function characterArtEntry(id: string): Readonly<CharacterArtEntry> | undefined {
  return isLocalStudioHost() ? manifest.value.entries[id] : undefined
}
export function characterArtRevision(id: string): string { return characterArtEntry(id)?.revision || 'builtin' }

/** Only catalog artwork paths can be substituted; external images and references stay untouched. */
export function remapCharacterArt(value: string): string {
  const path = value.split(/[?#]/, 1)[0].replace(/^\.\.\//, '/').replace(/^\.\//, '/')
  const studio = /^\/assets\/characters\/(nene|natsume)-official\.webp$/.exec(path)
  const popular = /^\/assets\/characters\/(thumbs\/)?popular-([a-z0-9_-]+)\.(png|webp)$/.exec(path)
  if (studio) return characterArtEntry(studio[1])?.portraitUrl || value
  if (popular && ((popular[1] && popular[3] === 'webp') || (!popular[1] && popular[3] === 'png'))) {
    const entry = characterArtEntry(popular[2])
    return (popular[1] ? entry?.thumbnailUrl : entry?.portraitUrl) || value
  }
  return value
}
