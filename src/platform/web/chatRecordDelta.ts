type Body = Record<string, unknown>
const object = (value: unknown): value is Body => !!value && typeof value === 'object' && !Array.isArray(value)
const decode = (value: unknown): Body => {
  const result: unknown = typeof value === 'string' ? JSON.parse(value) : value
  return object(result) ? structuredClone(result) : {}
}

/** Messages have stable identities; changing preferences never uploads their bodies. */
function split(value: unknown) {
  const header = decode(value), records = new Map<string, unknown>()
  function messages(owner: Body, field: string, path: string[]) {
    const list = owner[field]
    if (!Array.isArray(list)) return
    const ids = list.map(message => {
      if (!object(message) || typeof message.mid !== 'string' || !message.mid) throw new Error('聊天消息缺少稳定编号，原记录已保留。')
      const id = JSON.stringify([...path, message.mid])
      if (records.has(id)) throw new Error('聊天消息编号重复，原记录已保留。')
      records.set(id, message)
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

export function chatRecordDelta(before: unknown, value: unknown) {
  const next = split(value)
  let previous: ReturnType<typeof split>
  try { previous = split(before) }
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
