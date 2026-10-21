type Body = Record<string, unknown>
const object = (value: unknown): value is Body => !!value && typeof value === 'object' && !Array.isArray(value)
const decode = (value: unknown): Body => {
  if (typeof value === 'string') {
    const result: unknown = JSON.parse(value)
    return object(result) ? result : {}
  }
  return object(value) ? structuredClone(value) : {}
}

/** Messages have stable identities; changing preferences never uploads their bodies. */
function split(value: unknown, characters?: Set<string>) {
  const header = decode(value), records = new Map<string, unknown>()
  const seen = new Set<string>()
  function messages(owner: Body, field: string, path: string[]) {
    const list = owner[field]
    if (!Array.isArray(list)) return
    const ids = list.map(message => {
      if (!object(message) || typeof message.mid !== 'string' || !message.mid) throw new Error('聊天消息缺少稳定编号，原记录已保留。')
      const id = JSON.stringify([...path, message.mid])
      if (seen.has(id)) throw new Error('聊天消息编号重复，原记录已保留。')
      seen.add(id)
      if (!characters || characters.has(path[1])) records.set(id, message)
      return id
    })
    owner[field] = { $messages: ids }
  }
  if (object(header.histories)) for (const character of Object.keys(header.histories)) messages(header.histories, character, ['history', character])
  if (object(header.conversations)) for (const [character, conversation] of Object.entries(header.conversations)) {
    if (!object(conversation) || !Array.isArray(conversation.branches)) continue
    for (const branch of conversation.branches) {
      if (!object(branch) || typeof branch.id !== 'string') throw new Error('聊天分支缺少稳定编号。')
      messages(branch, 'messages', ['branch', character, branch.id])
    }
  }
  return { header, records }
}

export function chatRecordDelta(before: unknown, value: unknown, changedCharacters?: readonly string[]) {
  const characters = changedCharacters && new Set(changedCharacters)
  const next = split(value, characters)
  let previous: ReturnType<typeof split>
  try { previous = split(before, characters) }
  catch {
    // Older profiles have messages without mid. The domain normalizer assigns
    // IDs; replace that legacy envelope once under the same revision fence.
    return value
  }
  return {
    storageFormat: 'huiyu-chat-delta-v1', stringEncoded: typeof value === 'string', header: next.header,
    upsert: [...next.records].filter(([id, body]) => JSON.stringify(previous.records.get(id)) !== JSON.stringify(body)).map(([id, body]) => ({ id, body })),
    remove: [...previous.records.keys()].filter(id => !next.records.has(id)),
  }
}
