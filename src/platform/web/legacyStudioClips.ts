import type { StudioVideoRun } from '../../api/studioVideoApi'
import type { StudioProjectRepository } from '../../application/studio/projectRepository'
import { getDesktopRuntime } from '../desktop/runtime'
import { createWebStudioRepository } from './studioProjectRepository'
import { kvGet } from './kvStore'

export const browserStudioVideoKey = (projectId: string, sourceProfileId?: string) =>
  'aics-model-draft-studio-video-web-' + (sourceProfileId || 'browser') + '-' + projectId

/** Old browser receipts predate the explicit timeline selection. Match the immutable clip and its task before selecting. */
export async function recoverLegacyStudioClips(
  repo: StudioProjectRepository,
  projectId: string,
  runs: StudioVideoRun[],
  check: () => void
) {
  const legacy = runs.filter((run) => run.projectId === projectId && run.shotRevision === undefined)
  const done = legacy
    .filter((run) => run.status === 'succeeded' && run.clipVersionId && run.taskId)
    .sort((a, b) => b.createdAt - a.createdAt)
  if (done.length && repo.selectBrowserClip) {
    const data = await repo.getProject(projectId)
    const versions = new Map(data.versions.map((item) => [item.id, item]))
    const latest = new Map<string, StudioVideoRun>()
    for (const run of done) {
      if (!run.clipVersionId || latest.has(run.shotId)) continue
      const version = versions.get(run.clipVersionId)
      if (
        version?.mime.startsWith('video/') &&
        version.source.kind === 'generation' &&
        version.source.taskId === run.taskId
      )
        latest.set(run.shotId, run)
    }
    for (const shot of data.shots) {
      const run = latest.get(shot.id)
      if (shot.currentClipVersionId !== undefined || !run?.clipVersionId || !run.taskId) continue
      check()
      try {
        await repo.selectBrowserClip(shot, run.clipVersionId, run.taskId)
      } catch (error) {
        check()
        const current = (await repo.getProject(projectId)).shots.find((s) => s.id === shot.id)
        if (!current || current.currentClipVersionId === undefined) throw error
      }
    }
  }
  return !legacy.some((run) => run.status === 'queued' || run.status === 'running')
}

/** Read only locally verifiable old receipts; preserve unfamiliar backup records verbatim. */
export async function recoverStoredStudioClips(
  repo: StudioProjectRepository,
  projectId: string,
  check: () => void
) {
  const record = await kvGet<{ version?: number; runs?: StudioVideoRun[] }>(
    browserStudioVideoKey(projectId, getDesktopRuntime().bootstrap?.sourceProfileId)
  )
  check()
  if (record?.version !== 1 || !Array.isArray(record.runs)) return false
  const rows = record.runs.filter(
    (r) =>
      r &&
      r.projectId === projectId &&
      r.shotRevision === undefined &&
      r.status === 'succeeded' &&
      typeof r.shotId === 'string' &&
      typeof r.clipVersionId === 'string' &&
      typeof r.taskId === 'string' &&
      Number.isSafeInteger(r.createdAt)
  )
  if (!rows.length) return false
  await recoverLegacyStudioClips(repo, projectId, rows, check)
  return true
}

/** Use the same local upgrade before freezing an old profile which never reopened its storyboard page. */
export async function prepareLegacyStudioMigration(
  sourceProfileId: string,
  expectedOrigin: string,
  signal?: AbortSignal
) {
  const profile = getDesktopRuntime().bootstrap?.sourceProfileId
  function check() {
    signal?.throwIfAborted()
    if (
      location.origin !== expectedOrigin ||
      profile !== getDesktopRuntime().bootstrap?.sourceProfileId ||
      (profile && profile !== sourceProfileId)
    )
      throw new Error('创作项目的来源资料已改变，请重新开始迁移。')
  }
  check()
  const repo = createWebStudioRepository(check)
  const projects = await repo.listProjects()
  for (const project of projects) {
    check()
    await recoverStoredStudioClips(repo, project.id, check)
  }
}
