import {
  studioAssetKinds, type StudioAssetKind, type StudioAssetSource, type StudioAssetVersion,
  type StudioFrameSlot, type StudioProject, type StudioProjectSnapshot, type StudioShot
} from '../../../types/studioProject'

export interface StudioAssetImport {
  assetId?: string
  expectedRevision?: number
  versionId?: string
  title: string
  kind: StudioAssetKind
  source: StudioAssetSource
  blob?: Blob
  mediaAlias?: string
}
export interface StudioShotInitial { id: string; prompt?: string; firstVersionId?: string; legacy?: Record<string, unknown> }
export type StudioShotEdit = Partial<Pick<StudioShot, 'title' | 'prompt' | 'firstVersionId' | 'lastVersionId' | 'audioVersionId'>>
export interface StudioProjectRepository {
  assertCurrent(): void
  listProjects(): Promise<StudioProject[]>
  createProject(title: string): Promise<StudioProject>
  saveWorkbench(project: StudioProject, workbench: StudioProject['workbench']): Promise<StudioProject>
  getProject(id: string): Promise<StudioProjectSnapshot>
  createShot(projectId: string, title: string, initial?: StudioShotInitial): Promise<StudioShot>
  updateShot(shot: StudioShot, patch: StudioShotEdit): Promise<StudioShot>
  selectBrowserClip?(shot: StudioShot, versionId: string, taskId: string): Promise<StudioShot>
  bindFrame(shot: StudioShot, slot: StudioFrameSlot, versionId: string | null): Promise<StudioShot>
  importAsset(input: StudioAssetImport): Promise<StudioAssetVersion>
  readOriginal(version: StudioAssetVersion, signal?: AbortSignal): Promise<Blob>
}
export function studioText(value: string, limit: number, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.includes('\0') || value.length > limit)
    throw new Error('创作资料为空或超出长度限制')
  return empty ? value : value.trim()
}
export function studioShotEdit(patch: StudioShotEdit): StudioShotEdit {
  const result: StudioShotEdit = {}
  if (patch.title !== undefined) result.title = studioText(patch.title, 160)
  if (patch.prompt !== undefined) result.prompt = studioText(patch.prompt, 32_768, true)
  for (const key of ['firstVersionId', 'lastVersionId', 'audioVersionId'] as const) {
    const id = patch[key]
    if (id !== undefined) result[key] = id === null ? null : studioText(id, 160)
  }
  return result
}
export function studioSource(source: StudioAssetSource): StudioAssetSource {
  switch (source.kind) {
    case 'file': return { kind: source.kind, ...(source.name ? { name: studioText(source.name, 512) } : {}) }
    case 'artwork':
      if (typeof source.artworkId === 'number' && Number.isFinite(source.artworkId)) return { kind: source.kind, artworkId: source.artworkId }
      return { kind: source.kind, artworkId: studioText(source.artworkId as string, 256) }
    case 'catalog': {
      const { catalogRevision } = source
      if (catalogRevision !== undefined && (!Number.isSafeInteger(catalogRevision) || catalogRevision < 0)) throw new Error('目录修订号无效')
      return {
        kind: source.kind, catalogKind: studioText(source.catalogKind, 64), catalogId: studioText(source.catalogId, 256),
        ...(catalogRevision === undefined ? {} : { catalogRevision })
      }
    }
    case 'generation': {
      if (!Number.isSafeInteger(source.outputIndex) || source.outputIndex < 0 || !Array.isArray(source.inputVersionIds)
        || source.inputVersionIds.length > 128) throw new Error('生成来源无效')
      for (const key of ['seed', 'width', 'height'] as const) {
        const value = source[key]
        if (value !== undefined && (!Number.isSafeInteger(value) || value < (key === 'seed' ? 0 : 1)))
          throw new Error('生成种子或画幅无效')
      }
      const keyframe = source.keyframe
      if (keyframe !== undefined && (
        !keyframe || (keyframe.neutralAnchor !== undefined && keyframe.neutralAnchor !== true)
        || (keyframe.neutralAnchor && (source.inputVersionIds[0] !== keyframe.characterVersionId || keyframe.sceneVersionId !== undefined))
        || (keyframe.sceneVersionId !== undefined && !source.inputVersionIds.includes(keyframe.sceneVersionId))
      )) throw new Error('关键帧来源无效')
      return {
        kind: source.kind, taskId: studioText(source.taskId, 256), outputIndex: source.outputIndex,
        inputVersionIds: source.inputVersionIds.map(value => studioText(value, 160)),
        ...(source.seed === undefined ? {} : { seed: source.seed }),
        ...(source.width === undefined ? {} : { width: source.width }),
        ...(source.height === undefined ? {} : { height: source.height }),
        ...(source.modelId ? { modelId: studioText(source.modelId, 256) } : {}),
        ...(source.prompt ? { prompt: studioText(source.prompt, 32_768, true) } : {}),
        ...(keyframe ? { keyframe: {
          characterVersionId: studioText(keyframe.characterVersionId, 160),
          ...(keyframe.neutralAnchor ? { neutralAnchor: true } : {}),
          ...(keyframe.sceneVersionId === undefined ? {} : { sceneVersionId: studioText(keyframe.sceneVersionId, 160) }),
        } } : {})
      }
    }
    default: throw new Error('未知的素材来源')
  }
}
export function checkedImport(input: StudioAssetImport) {
  if (!studioAssetKinds.includes(input.kind) || (!input.blob?.size && !input.mediaAlias)) throw new Error('请选择有效的素材原件')
  const source = studioSource(input.source)
  if (source.kind === 'generation' && source.keyframe?.neutralAnchor && input.kind !== 'character')
    throw new Error('干净基准立绘必须保存为角色立绘')
  const versionId = studioText(input.versionId ?? crypto.randomUUID(), 160)
  if (input.assetId !== undefined && (!Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision ?? 0) < 1))
    throw new Error('更新素材版本需要当前素材修订号')
  return {
    versionId, assetId: studioText(input.assetId ?? versionId, 160), title: studioText(input.title, 160),
    kind: input.kind, expectedRevision: input.assetId === undefined ? 0 : input.expectedRevision, source
  }
}
export function studioMediaMatches(kind: StudioAssetKind, mime: string) {
  if (kind === 'audio') return mime === 'audio/wav'
  if (kind === 'clip') return ['video/mp4', 'video/webm'].includes(mime)
  return ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'].includes(mime)
}
export function studioWorkbench(value: StudioProject['workbench'], limit = 262_144) {
  if (value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('工坊草稿无效')
  const encoded = JSON.stringify(value)
  if (new TextEncoder().encode(encoded).length > limit) throw new Error('创作记录过大，请拆分保存')
  return JSON.parse(encoded) as Record<string, unknown>
}
