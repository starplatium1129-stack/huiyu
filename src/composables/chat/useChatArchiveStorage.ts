import { ref } from 'vue'
import { readChatArchive, writeChatArchive, withChatArchiveMutation } from '@/storage/chatArchiveRepository'
import { archiveMessages, emptyChatArchive, type ChatArchive } from '@/utils/chatArchive'
import type { PersistedChatMessage } from '@/utils/chatStorageCore'

type Mutation = { character: string; revision: string; all?: boolean; messages?: PersistedChatMessage[] }

/** All archive writers serialize the read/modify/write under one origin-wide lock.
 * A per-character clear epoch rejects additions queued against a deleted snapshot.
 * Failed operations stay in memory for retry; the persisted record is never removed.
 */
export function useChatArchiveStorage(characterIds: string[], canWrite: () => boolean, onError: (message: string) => void) {
  const archive = ref<ChatArchive>(emptyChatArchive(characterIds))
  let pending: Mutation[] = []
  let running: Promise<boolean> | undefined
  let generation = 0
  const read = () => readChatArchive(characterIds)
  function apply(base: ChatArchive, mutations: Mutation[]) {
    base.revisions ||= {}
    for (const mutation of mutations) {
      if (mutation.all) {
        for (const id of Object.keys(base.archived)) {
          base.archived[id] = []
          Object.defineProperty(base.revisions, id, { value: mutation.revision, writable: true, enumerable: true, configurable: true })
        }
      } else if (!mutation.messages) {
        base.archived[mutation.character] = []
        Object.defineProperty(base.revisions, mutation.character, { value: mutation.revision, writable: true, enumerable: true, configurable: true })
      } else if ((typeof base.revisions[mutation.character] === 'string' ? base.revisions[mutation.character] : '') === mutation.revision) {
        archiveMessages(base, mutation.character, mutation.messages)
      }
    }
    return base
  }
  async function refresh(synchronized = false) {
    const started = generation
    const value = await (synchronized ? withChatArchiveMutation(read) : read())
    if (started === generation) archive.value = apply(value, pending)
  }
  const ready = refresh()
  function reset() {
    generation++
    pending = []
    archive.value = emptyChatArchive(characterIds)
  }
  function add(character: string, messages: PersistedChatMessage[], imported = false) {
    if ((!imported && !characterIds.includes(character)) || !messages.length) return
    const revision = typeof archive.value.revisions?.[character] === 'string' ? archive.value.revisions[character] : ''
    const mutation = { character, revision, messages: messages.map(message => ({ ...message })) }
    pending.push(mutation)
    archive.value = apply(archive.value, [mutation])
  }
  function clear(character?: string) {
    if (character && !Object.hasOwn(archive.value.archived, character)) return
    const mutation = { character: character || '', all: !character, revision: crypto.randomUUID() }
    pending.push(mutation)
    archive.value = apply(archive.value, [mutation])
  }
  function save(): Promise<boolean> {
    if (running) return running.then(success => success && pending.length ? save() : success)
    if (!pending.length) return Promise.resolve(true)
    const started = generation
    running = Promise.resolve().then(async () => {
      try {
        await ready
        return await withChatArchiveMutation(async () => {
          if (started !== generation || !canWrite()) return false
          const batch = pending.slice()
          const next = apply(await read(), batch)
          if (started !== generation || !canWrite()) return false
          await writeChatArchive(next)
          generation++
          pending.splice(0, batch.length)
          archive.value = apply(next, pending)
          return true
        })
      } catch (error) {
        onError(error instanceof Error && error.message.includes('浏览器不支持') ? error.message : '浏览器存储空间不足，聊天归档暂未保存；内容保留在当前窗口，请重试保存。')
        return false
      }
    }).finally(() => { running = undefined })
    return running
  }
  void ready.catch(() => {})
  return { archive, ready, refresh, reset, add, clear, save }
}
