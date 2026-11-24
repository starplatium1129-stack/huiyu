import { shallowRef } from 'vue'

const revision = shallowRef(0)
let installed = ''

export function setDownloadedPortraitIdentity(identity: string): void {
  if (identity === installed) return
  installed = identity
  revision.value++
}

export function refreshablePackPortrait(source: string): string {
  const match = source.match(/^((?:https?:\/\/[^/]+)?\/assets\/characters\/popular-[\w-]+\.(?:png|jpe?g|webp))(?:\?([^#]*))?(#.*)?$/i)
  if (!match || !revision.value) return source
  const query = new URLSearchParams(match[2])
  query.set('_mediaPack', String(revision.value))
  return `${match[1]}?${query}${match[3] ?? ''}`
}
