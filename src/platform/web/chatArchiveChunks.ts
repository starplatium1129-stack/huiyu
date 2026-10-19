const FORMAT = 'huiyu-chat-archive-chunks-v1'
const CHUNK_CHARS = 64 * 1024

/** Message anchors keep old history reusable even when the 5,000-message window
 * drops its oldest entry. Large groups are also split into bounded text chunks.
 * The final CAS publishes all branches together. Unpublished chunks are harmless.
 */
export async function prepareChatArchiveChunks(value: unknown, expectedReset: string,
  request: <T>(command: Record<string, unknown>) => Promise<T>): Promise<unknown> {
  const archive = typeof value === 'string' ? JSON.parse(value) : value
  if (!archive || typeof archive !== 'object' || !archive.archived || typeof archive.archived !== 'object') throw new Error('聊天归档结构不完整，原件已保留。')
  const chunks = new Map<string, string>()
  async function encode(serialized: string): Promise<string[]> {
    const hashes: string[] = []
    for (let offset = 0; offset < serialized.length;) {
      let end = Math.min(offset + CHUNK_CHARS, serialized.length)
      const last = serialized.charCodeAt(end - 1)
      if (end < serialized.length && last >= 0xd800 && last <= 0xdbff) end--
      const data = serialized.slice(offset, end)
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data))
      const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
      hashes.push(hash); chunks.set(hash, data); offset = end
    }
    return hashes
  }
  const branches: Record<string, string[][]> = Object.create(null)
  for (const [id, messages] of Object.entries(archive.archived)) {
    if (!Array.isArray(messages)) throw new Error('聊天归档分支格式异常。')
    const groups: string[][] = []
    let parts: string[] = [], chars = 2
    for (const message of messages) {
      const serialized = JSON.stringify(message)
      const identity = String(message?.replyId || message?.mid || serialized)
      let anchor = 2166136261
      for (let index = 0; index < identity.length; index++) anchor = Math.imul(anchor ^ identity.charCodeAt(index), 16777619)
      parts.push(serialized); chars += serialized.length + 1
      if (chars >= CHUNK_CHARS || (anchor & 15) === 0) {
        groups.push(await encode(`[${parts.join(',')}]`)); parts = []; chars = 2
      }
    }
    if (parts.length) groups.push(await encode(`[${parts.join(',')}]`))
    branches[id] = groups
  }
  const manifest = await encode(JSON.stringify({ version: archive.version, archived: branches, revisions: archive.revisions || {} }))
  // Bound metadata requests too, even when importing many old branches.
  const hashes = [...chunks.keys()]
  for (let offset = 0; offset < hashes.length; offset += 1000) {
    const batch = hashes.slice(offset, offset + 1000)
    const missing = await request<string[]>({ kind: 'profile.archiveMissing', operationId: crypto.randomUUID(), hashes: batch, expectedReset })
    if (!Array.isArray(missing) || missing.some(hash => !batch.includes(hash))) throw new Error('聊天归档分块回执无效。')
    for (const hash of missing) await request({ kind: 'profile.archiveChunk', hash, data: chunks.get(hash), expectedReset })
  }
  return { storageFormat: FORMAT, manifest }
}
