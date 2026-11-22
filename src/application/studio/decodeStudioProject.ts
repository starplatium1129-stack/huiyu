import { studioAssetKinds, type StudioAsset, type StudioAssetVersion, type StudioProject, type StudioProjectSnapshot, type StudioShot } from '../../../types/studioProject'
import { studioSource, studioMediaMatches } from './projectRepository'

function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('工作区创作记录无效')
  return value as Record<string, unknown>
}
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0 }
function number(value: unknown, min: number) { return Number.isSafeInteger(value) && Number(value) >= min }
function entity(value: unknown) {
  const r = row(value)
  if (!text(r.id) || !text(r.title) || !number(r.revision, 1)) throw new Error('工作区记录身份无效')
  return r
}
export function studioProject(value: unknown): StudioProject {
  const r = entity(value)
  if (r.workbench !== null) row(r.workbench)
  return r as unknown as StudioProject
}
export function studioShot(value: unknown): StudioShot {
  const r = entity(value)
  if (!text(r.projectId) || typeof r.prompt !== 'string' || !number(r.position, 0)
    || ![r.firstVersionId, r.lastVersionId].every(id => id === null || text(id))
    || ![r.audioVersionId, r.currentClipVersionId].every(id => id == null || text(id))) throw new Error('分镜槽位数据无效')
  if (r.legacy !== undefined) row(r.legacy)
  return r as unknown as StudioShot
}
function studioAsset(value: unknown): StudioAsset {
  const r = entity(value)
  if (!studioAssetKinds.some(kind => kind === r.kind)) throw new Error('素材种类无效')
  return r as unknown as StudioAsset
}
export function studioVersion(value: unknown): StudioAssetVersion {
  const r = row(value)
  if (!text(r.id) || !text(r.assetId) || !text(r.mediaAlias) || !text(r.sha256) || !/^[0-9a-f]{64}$/.test(r.sha256)
    || !text(r.mime) || !number(r.bytes, 1) || !number(r.number, 1)) throw new Error('素材版本无效')
  studioSource(row(r.source) as unknown as StudioAssetVersion['source'])
  return r as unknown as StudioAssetVersion
}
export function studioProjects(value: unknown) {
  if (!Array.isArray(value)) throw new Error('项目列表无效')
  return value.map(studioProject)
}
export function studioSnapshot(value: unknown, projectId: string): StudioProjectSnapshot {
  const r = row(value), project = studioProject(r.project)
  if (project.id !== projectId || !Array.isArray(r.shots) || !Array.isArray(r.assets) || !Array.isArray(r.versions))
    throw new Error('项目工作区响应无效')
  const shots = r.shots.map(studioShot), assets = r.assets.map(studioAsset), versions = r.versions.map(studioVersion)
  const byId = new Map(assets.map(asset => [asset.id, asset]))
  if (shots.some(shot => shot.projectId !== projectId) || versions.some(version => {
    const asset = byId.get(version.assetId)
    return !asset || !studioMediaMatches(asset.kind, version.mime)
  })) throw new Error('项目或素材引用无效')
  return { project, shots, assets, versions }
}
