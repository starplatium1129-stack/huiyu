import type { ArtworkRepository } from '../../application/artwork/artworkRepository'
import type { StudioProjectRepository } from '../../application/studio/projectRepository'
import { checkedImport, studioShotEdit, studioText, studioWorkbench } from '../../application/studio/projectRepository'
import { studioProjects, studioProject, studioShot, studioVersion, studioSnapshot } from '../../application/studio/decodeStudioProject'
import { normalizeStudioMedia } from '../../application/studio/studioMedia'
import { workspaceRequest, WorkspaceRequestError } from '../../api/workspace'
import { imageBlobDigest } from '../../utils/imageBlobDigest'
import { createArtworkCommandWriter } from './artworkCommands'
import { workspaceMediaAuthority, workspaceMediaSource } from './workspaceMediaSource'
import { trackMaintenanceWrite } from '../maintenanceParticipants'

export function createDesktopStudioRepository(artwork: ArtworkRepository, check: () => void): StudioProjectRepository {
  const authority = () => { check(); return workspaceMediaAuthority() }
  const send = createArtworkCommandWriter(workspaceRequest, authority, () => { })
  const read = async (kind: string, id?: string) => {
    check()
    const data = await workspaceRequest<unknown>({ kind, id })
    check()
    return data
  }
  const write = <T>(change: Record<string, unknown>, decode: (result: unknown) => T) =>
    trackMaintenanceWrite(() => send({ kind: 'studio.write', operationId: crypto.randomUUID(), change }, receipt => decode(receipt.result)))
  return {
    assertCurrent: check,
    listProjects: async () => studioProjects(await read('studio.list')),
    getProject: async id => studioSnapshot(await read('studio.get', id), id),
    createProject: title => write({ action: 'createProject', id: crypto.randomUUID(), title: studioText(title, 160) }, studioProject),
    saveWorkbench: (project, workbench) => write({
      action: 'saveWorkbench', id: project.id, expectedRevision: project.revision,
      workbench: studioWorkbench(workbench)
    }, studioProject),
    createShot: (projectId, title, initial) => write({
      action: 'createShot', id: initial?.id ?? crypto.randomUUID(), projectId,
      title: studioText(title, 160), prompt: studioText(initial?.prompt ?? '', 32_768, true), firstVersionId: initial?.firstVersionId ?? null,
      ...(initial?.legacy ? { legacy: studioWorkbench(initial.legacy, 65_536) } : {})
    }, studioShot),
    updateShot: (shot, patch) => write({
      action: 'updateShot', id: shot.id, expectedRevision: shot.revision,
      ...studioShotEdit(patch)
    }, studioShot),
    bindFrame: (shot, slot, id) => write({
      action: 'updateShot', id: shot.id, expectedRevision: shot.revision,
      [slot === 'first' ? 'firstVersionId' : 'lastVersionId']: id
    }, studioShot),
    importAsset: input => trackMaintenanceWrite(async () => {
      const data = checkedImport(input)
      check()
      let alias = input.mediaAlias, sha256: string | undefined, uploaded = false
      if (input.blob) {
        const media = workspaceMediaSource(input.blob)
        const blob = await normalizeStudioMedia(input.blob, data.kind)
        sha256 = (await imageBlobDigest(blob, check)).sha256
        if (!alias && media?.sha256 === sha256) alias = media.alias
        if (!alias) {
          alias = await artwork.putImage(blob)
          uploaded = true
        }
      }
      check()
      try {
        return await write({ action: 'importAsset', ...data, mediaAlias: alias, ...(sha256 ? { sha256 } : {}), consumeUpload: uploaded }, studioVersion)
      } catch (error) {
        // A lost commit response may still hold this upload. A definite rejection leaves no asset reference.
        if (uploaded && alias && error instanceof WorkspaceRequestError && error.status >= 400 && error.status < 500) {
          check()
          await artwork.deleteImage(alias)
        }
        throw error
      }
    }),
    async readOriginal(version, signal) {
      check(); signal?.throwIfAborted()
      const blob = await artwork.getImage(version.mediaAlias, signal)
      check(); signal?.throwIfAborted()
      if (!blob || blob.size !== version.bytes || blob.type !== version.mime
        || (await imageBlobDigest(blob, check)).sha256 !== version.sha256) throw new Error('素材原件与保存版本不一致')
      signal?.throwIfAborted()
      return blob
    },
  }
}
