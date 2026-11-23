import { runtimeFetch, runtimeResourceIdentity } from '@/platform/runtimeUrl'
import { isLocalStudioHost } from './runtimeEnvironment'

let owner: string | undefined
let pending: Promise<Record<string, unknown>[]> | undefined

/** Both the directory and persona memory share this read, including on earlier gateways. */
export function loadChatCharacterProfiles(force = false) {
  const identity = runtimeResourceIdentity()
  if (owner !== identity || force) {
    owner = identity
    pending = undefined
  }
  if (pending) return pending
  const signal = AbortSignal.timeout(10_000)
  const read = async () => {
    const fetchRows = (file: string) => runtimeFetch(`/data/${file}`, { signal, cache: 'no-cache' })
    let response = await fetchRows(isLocalStudioHost() ? 'character-chat.json' : 'characters.json')
    if (response.status === 404 && isLocalStudioHost()) response = await fetchRows('characters.json')
    if (!response.ok) throw new Error('聊天角色资料暂不可用')
    const rows: unknown = await response.json()
    if (!Array.isArray(rows)) throw new Error('聊天角色资料格式错误')
    return rows.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object' && typeof row.id === 'string')
  }
  const current = read().catch(error => {
    if (pending === current) pending = undefined
    throw error
  })
  return pending = current
}
