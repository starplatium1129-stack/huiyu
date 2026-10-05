import { ARTWORK_HISTORY_KEY, ARTWORK_PROJECTS_KEY, comparableId, record, type ArtworkKvAdapter } from './artworkStorage.ts'
import { ARTWORK_ORGANIZATION_RECEIPT_LIMIT, COLLECTION_TAG_LIMIT, collectionTags, normalizeArtworkOrganization,
  type ArtworkOrganizationRequest, type ArtworkOrganizationReceipt, type ArtworkOrganizationState,
  type ArtworkOrganizationId, type ArtworkOrganizationUndoResult } from '../../application/artwork/organization.ts'

interface Dependencies {
  kv: ArtworkKvAdapter
  commit: (entries: Array<{ key: string; value: unknown }>, operation: string) => Promise<void>
  enqueue: <T>(work: () => Promise<T>) => Promise<T>
}
const field = (source: Record<string, unknown>, name: string) => ({ present: Object.hasOwn(source, name),
  ...(Object.hasOwn(source, name) ? { value: structuredClone(source[name]) } : {}) })
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export function createArtworkOrganization({ kv, commit, enqueue }: Dependencies) {
  // Receipts contain only metadata. A detached copy keeps callers from changing the undo authority.
  const receipts = new Map<string, ArtworkOrganizationReceipt>()
  async function read() {
    const [history, projects] = await Promise.all([kv.get(ARTWORK_HISTORY_KEY), kv.get(ARTWORK_PROJECTS_KEY)])
    return { history: structuredClone(Array.isArray(history) ? history : []) as unknown[],
      projects: structuredClone(Array.isArray(projects) ? projects : []) as unknown[] }
  }
  async function commitChecked(entries: Array<{ key: string; value: unknown }>, operation: string) {
    try { await commit(entries, operation) }
    catch (error) {
      // A transport/storage rejection can follow a committed transaction. Read
      // the same authority while its lock is held before declaring failure.
      const saved = await Promise.all(entries.map(entry => kv.get(entry.key))).catch(() => null)
      if (!saved || entries.some((entry, index) => !equal(saved[index], entry.value))) throw error
    }
  }
  function memberships(projects: unknown[], target: string) {
    return projects.flatMap(value => {
      const project = record(value)
      if (!project || Object.hasOwn(project, 'smartRule') || !comparableId(project.id) || !Array.isArray(project.history_ids)) return []
      const position = project.history_ids.findIndex(id => comparableId(id) === target)
      return position < 0 ? [] : [{ projectId: project.id as ArtworkOrganizationId, position }]
    })
  }
  function state(source: Record<string, unknown>, projects: unknown[], input: ArtworkOrganizationRequest): ArtworkOrganizationState {
    return { ...(input.projectId !== undefined ? { project: field(source, 'project'), memberships: memberships(projects, comparableId(source.id)!) } : {}),
      ...(input.collectionTags ? { collectionTags: field(source, 'collectionTags') } : {}) }
  }
  function replaceMemberships(projects: unknown[], artworkId: ArtworkOrganizationId, refs: NonNullable<ArtworkOrganizationState['memberships']>) {
    const target = comparableId(artworkId)!
    for (const value of projects) {
      const project = record(value)
      if (!project || Object.hasOwn(project, 'smartRule')) continue
      const ref = refs.find(item => comparableId(item.projectId) === comparableId(project.id))
      const previous = Array.isArray(project.history_ids) ? project.history_ids : []
      const next = previous.filter(id => comparableId(id) !== target)
      if (ref) next.splice(Math.min(ref.position, next.length), 0, artworkId)
      if (ref || next.length !== previous.length) project.history_ids = next
    }
  }
  async function organizeArtworks(input: ArtworkOrganizationRequest): Promise<ArtworkOrganizationReceipt> {
    const request = normalizeArtworkOrganization(structuredClone(input))
    return enqueue(async () => {
      const { history, projects } = await read()
      const project = request.projectId == null ? null : projects.map(record).find(value => comparableId(value?.id) === comparableId(request.projectId))
      if (request.projectId != null && !project) throw new Error('画册已不存在，请重新读取后选择')
      if (project && Object.hasOwn(project, 'smartRule')) throw new Error('智能画册按条件收录，请修改画册条件')
      const receipt: ArtworkOrganizationReceipt = { operationId: `organize-${crypto.randomUUID()}`, changes: [] }
      for (const id of request.ids) {
        const source = history.map(record).find(value => comparableId(value?.id) === comparableId(id))
        if (!source) throw new Error('部分作品已不在作品册，请重新读取后选择')
        const before = state(source, projects, request)
        if (request.projectId !== undefined) {
          if (project) source.project = comparableId(project.id)!
          else delete source.project
          const references = project && Array.isArray(project.history_ids) ? project.history_ids : []
          const existing = references.findIndex(value => comparableId(value) === comparableId(source.id))
          const position = existing >= 0 ? existing : references.length
          replaceMemberships(projects, source.id as ArtworkOrganizationId, project ? [{ projectId: project.id as ArtworkOrganizationId, position }] : [])
        }
        if (request.collectionTags) {
          const remove = new Set(request.collectionTags.remove)
          source.collectionTags = [...new Set([...collectionTags(source.collectionTags).filter(tag => !remove.has(tag)), ...request.collectionTags.add!])]
          if ((source.collectionTags as string[]).length > COLLECTION_TAG_LIMIT) throw new Error('每幅作品最多保留 64 个整理标签')
        }
        const after = state(source, projects, request)
        if (!equal(before, after)) receipt.changes.push({ id: source.id as ArtworkOrganizationId, before, after })
      }
      if (receipt.changes.length) {
        await commitChecked([{ key: ARTWORK_HISTORY_KEY, value: history },
          ...(request.projectId !== undefined ? [{ key: ARTWORK_PROJECTS_KEY, value: projects }] : [])], '作品整理')
        // This web-only cache is undo authority, not the desktop idempotency ledger.
        // No-op retries must not evict the last actual changes.
        receipts.set(receipt.operationId, structuredClone(receipt))
        while (receipts.size > ARTWORK_ORGANIZATION_RECEIPT_LIMIT) receipts.delete(receipts.keys().next().value!)
      }
      return structuredClone(receipt)
    })
  }
  async function undoArtworkOrganization(receipt: ArtworkOrganizationReceipt): Promise<ArtworkOrganizationUndoResult> {
    const operationId = receipt.operationId
    return enqueue(async () => {
      const original = receipts.get(operationId)
      if (!original) throw new Error('本次整理的撤销记录已不可用')
      const { history, projects } = await read()
      let restored = 0, skipped = 0, projectsChanged = false
      for (const change of [...original.changes].reverse()) {
        const source = history.map(record).find(value => comparableId(value?.id) === comparableId(change.id))
        if (!source) { skipped++; continue }
        const after = change.after
        const sameMemberships = !after.memberships || equal(memberships(projects, comparableId(change.id)!).map(ref => comparableId(ref.projectId)).sort(),
          after.memberships.map(ref => comparableId(ref.projectId)).sort())
        const allAlbumsExist = !change.before.memberships || change.before.memberships.every(ref => projects.some(value => {
          const project = record(value)
          return project && !Object.hasOwn(project, 'smartRule') && comparableId(project.id) === comparableId(ref.projectId)
        }))
        if (!sameMemberships || !allAlbumsExist || (after.project && !equal(field(source, 'project'), after.project))
          || (after.collectionTags && !equal(field(source, 'collectionTags'), after.collectionTags))) { skipped++; continue }
        for (const name of ['project', 'collectionTags'] as const) {
          const previous = change.before[name]
          if (!previous) continue
          if (previous.present) source[name] = structuredClone(previous.value)
          else delete source[name]
        }
        if (change.before.memberships) { replaceMemberships(projects, source.id as ArtworkOrganizationId, change.before.memberships); projectsChanged = true }
        restored++
      }
      if (restored) await commitChecked([{ key: ARTWORK_HISTORY_KEY, value: history },
        ...(projectsChanged ? [{ key: ARTWORK_PROJECTS_KEY, value: projects }] : [])], '撤销作品整理')
      receipts.delete(operationId)
      return { restored, skipped }
    })
  }
  return { organizeArtworks, undoArtworkOrganization }
}
