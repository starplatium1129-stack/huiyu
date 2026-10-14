import type { MigrationCandidateSelection, MigrationEnvelope, MigrationStatus } from '../../../types/migration'
import { createMigrationDirectoryBackup, readMigrationDirectoryBackup } from './migrationBackup'
import { exportMigrationSource, migrationFingerprint } from './migrationExport'
import { importMigrationBackup, type MigrationCandidatePort } from './migrationImport'
import { assertMigrationArtworkSourcesReady, freezeMigrationSource, migrationRecoveryPending, WRITE_LOCK, WINDOW_LOCK,
  type MigrationSourceSnapshot, type MigrationSourceAck, type MigrationSourcePreparedAck } from './migrationBarrier'

/** Loaded only for an explicit migration/export. All browser identity and native
 * marker operations belong to the source captured before this module loaded. */
export async function freezeMigrationWindows<T>(work: (snapshot: MigrationSourceSnapshot) => Promise<T>, source: Readonly<{
  windowId: string; channel: BroadcastChannel
  prepare(requestId: string): Promise<void>; seal(requestId: string): boolean; release(requestId: string): void
  isBusy(): boolean; sessionSnapshot(): Record<string, string>
  mark(requestId: string): void; clear(requestId: string): void
}>, signal?: AbortSignal): Promise<T> {
  return navigator.locks.request('huiyu:migration:coordinator', { ifAvailable: true }, async lock => {
    if (!lock) throw new Error('另一窗口正在迁移。')
    if (migrationRecoveryPending()) throw new Error('上次激活结果尚未确认，请先执行只读核对。')
    return freeze()
  })
  async function freeze(): Promise<T> {
    // The coordinator lock proves an old marker has no owner. Adopt it while
    // writes stay blocked; never infer liveness from a timestamp or thaw early.
    const requestId = crypto.randomUUID()
    const held = await navigator.locks.query()
    const expected = new Set([...(held.held || []), ...(held.pending || [])].map(item => item.name || '').filter(name => name.startsWith(WINDOW_LOCK)).map(name => name.slice(WINDOW_LOCK.length)))
    expected.add(source.windowId)
    source.mark(requestId)
    try {
      await new Promise<void>((resolve, reject) => {
        const prepared = new Set<string>()
        let settled = false
        const timeout = setTimeout(() => finish(new Error('有窗口尚未保存当前草稿，迁移未开始。')), 6000)
        const abort = () => finish(signal?.reason || new Error('迁移已取消。'))
        const onMessage = (event: MessageEvent<MigrationSourcePreparedAck>) => {
          const ack = event.data
          if (ack.type !== 'prepared' || ack.requestId !== requestId || !expected.has(ack.windowId)) return
          if (ack.ok !== true) { finish(new Error('有窗口尚未保存当前草稿或仍在操作，迁移未开始。')); return }
          prepared.add(ack.windowId)
          if (prepared.size === expected.size) finish()
        }
        function finish(error?: unknown) {
          if (settled) return
          settled = true; clearTimeout(timeout); source.channel.removeEventListener('message', onMessage); signal?.removeEventListener('abort', abort)
          if (error) reject(error); else resolve()
        }
        source.channel.addEventListener('message', onMessage); signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) { abort(); return }
        source.channel.postMessage({ type: 'prepare', requestId })
        void source.prepare(requestId).then(() => {
          prepared.add(source.windowId)
          if (prepared.size === expected.size) finish()
        }, finish)
      })
      // Participants may need these locks while flushing. Acquire them only
      // afterwards, preserving the ordinary backup lock order.
      return await navigator.locks.request('huiyu-artwork-library', { signal }, () =>
        navigator.locks.request('aics_chat_archive_v1', { signal }, () =>
          navigator.locks.request(WRITE_LOCK, { mode: 'exclusive', signal }, snapshot)))
    } finally {
      source.clear(requestId)
      source.release(requestId)
      source.channel.postMessage({ type: 'release', requestId })
    }
    async function snapshot(): Promise<T> {
      if (!source.seal(requestId)) throw new Error('当前窗口尚未完成资料保存，迁移未开始。')
      assertMigrationArtworkSourcesReady()
      if (source.isBusy()) throw new Error('仍有生成或保存任务，请待任务安全结束后再迁移。')
      const sessions: MigrationSourceSnapshot['sessions'] = { [source.windowId]: source.sessionSnapshot() }
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => finish(new Error('有窗口未确认维护，迁移未开始。')), 5000)
        const abort = () => finish(signal?.reason || new Error('迁移已取消。'))
        const onMessage = (event: MessageEvent<MigrationSourceAck>) => {
          const ack = event.data
          if (ack.type !== 'ack' || ack.requestId !== requestId || !expected.has(ack.windowId)) return
          if (ack.prepared !== true) { finish(new Error('其他窗口尚未完成草稿保存。请重新打开该窗口后再迁移。')); return }
          if (typeof ack.pendingArtwork !== 'boolean') { finish(new Error('其他窗口尚未确认未入册成片是否落稳。请先入册，或下载原图后明确清除，重新打开该窗口后再迁移。')); return }
          if (ack.pendingArtwork) { finish(new Error('其他窗口仍有生成任务或未落稳的成片。请等待生成结束并入册，或下载原图后明确清除，再迁移。')); return }
          if (ack.busy) { finish(new Error('其他窗口仍有进行中的任务。')); return }
          sessions[ack.windowId] = ack.session
          if (Object.keys(sessions).length === expected.size) finish()
        }
        function finish(error?: unknown) {
          clearTimeout(timeout); source.channel.removeEventListener('message', onMessage); signal?.removeEventListener('abort', abort)
          if (error) reject(error); else resolve()
        }
        source.channel.addEventListener('message', onMessage)
        signal?.addEventListener('abort', abort, { once: true })
        source.channel.postMessage({ type: 'freeze', requestId })
        if (expected.size === 1) finish()
      })
      const now = await navigator.locks.query()
      const live = [...(now.held || []), ...(now.pending || [])].map(item => item.name || '').filter(name => name.startsWith(WINDOW_LOCK)).map(name => name.slice(WINDOW_LOCK.length))
      if (live.some(id => !expected.has(id))) throw new Error('维护期间打开了新窗口，请重新盘点。')
      signal?.throwIfAborted()
      return work({ windowIds: [...expected].sort(), sessions })
    }
  }
}
/** Run from the original origin/profile. The selected directory receives and
 * verifies a complete independent backup before a candidate sees any records.
 * Activation, if requested by the host, remains inside the maintenance barrier. */
export async function migrateProfileToCandidate(options: {
  sourceProfileId: string
  expectedOrigin: string
  backupDirectory: FileSystemDirectoryHandle
  prepareCandidate: (selection: MigrationCandidateSelection) => Promise<MigrationCandidatePort & { workspaceId: string }>
  signal?: AbortSignal
  migrateCredential?: (reference: string, secret: string) => Promise<boolean>
  activate?: (verified: MigrationStatus) => Promise<void>
  onProgress?: (phase: 'export' | 'import' | 'verify', completed: number, total: number) => void
  resume?: boolean
}): Promise<{ envelope: MigrationEnvelope; status: MigrationStatus; backupName: string }> {
  if (options.resume) return resumeProfileMigration(options)
  options.signal?.throwIfAborted()
  assertMigrationArtworkSourcesReady()
  // A candidate already changes the host descriptor. Check every source window
  // under the existing freeze before that change, not only during later export.
  const candidate = await freezeMigrationSource(async () => {
    assertMigrationArtworkSourcesReady()
    return options.prepareCandidate({ mode: 'new' })
  }, options.signal)
  options.signal?.throwIfAborted()
  const sink = await createMigrationDirectoryBackup(options.backupDirectory)
  let status: MigrationStatus | undefined
  const envelope = await exportMigrationSource({ sourceProfileId: options.sourceProfileId, expectedOrigin: options.expectedOrigin,
    signal: options.signal, sink, target: { workspaceId: candidate.workspaceId }, migrateCredential: options.migrateCredential,
    consume: async envelope => {
      if (envelope.blockers.length) throw new Error('来源包含未分类资料或未迁移凭据，已保留独立备份，尚未激活。')
      status = await importMigrationBackup(envelope, sink, candidate, options)
      if (status.state !== 'verified' || status.blockers.length) throw new Error('迁移校验发现缺失或冲突，来源与备份已保留，尚未激活。')
      options.signal?.throwIfAborted()
      await options.activate?.(status)
    },
  })
  return { envelope, status: status!, backupName: sink.backupName }
}

async function resumeProfileMigration(options: Parameters<typeof migrateProfileToCandidate>[0]) {
  const reader = await readMigrationDirectoryBackup(options.backupDirectory)
  const { fingerprint, ...unsigned } = reader.envelope
  if (await migrationFingerprint(unsigned) !== fingerprint || reader.envelope.blockers.length) throw new Error('迁移备份指纹不一致或有未解决的来源问题。')
  const sourceSnapshot = ({ source, records, media, credentials }: MigrationEnvelope) => ({ source, records, media, credentials })
  let status: MigrationStatus | undefined
  await exportMigrationSource({ sourceProfileId: options.sourceProfileId, expectedOrigin: options.expectedOrigin,
    signal: options.signal, migrateCredential: options.migrateCredential,
    // Existing independently saved files remain the backup; this pass verifies
    // the live source has not changed before reusing the saved checkpoint.
    sink: { record: async () => {}, media: async () => {}, manifest: async () => {}, verify: async () => {} },
    consume: async current => {
      if (current.blockers.length || await migrationFingerprint(sourceSnapshot(current)) !== await migrationFingerprint(sourceSnapshot(reader.envelope))) {
        throw new Error('来源已变化，不能把旧检查点套用到新资料；已保留旧备份与候选，请重新选择“迁移至本机工作区”建立新候选。')
      }
      options.signal?.throwIfAborted()
      assertMigrationArtworkSourcesReady()
      const candidate = await options.prepareCandidate({ mode: 'resume', workspaceId: reader.envelope.target?.workspaceId,
        migrationId: reader.envelope.migrationId, expectedFingerprint: reader.envelope.fingerprint })
      status = await importMigrationBackup(reader.envelope, reader, candidate, options)
      if (status.state !== 'verified' || status.blockers.length) throw new Error('迁移副本尚未通过完整性校验。')
      options.signal?.throwIfAborted()
      await options.activate?.(status)
    },
  })
  return { envelope: reader.envelope, status: status!, backupName: options.backupDirectory.name }
}
