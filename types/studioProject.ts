export const studioAssetKinds = ['character', 'outfit', 'expression', 'pose', 'scene', 'keyframe', 'audio', 'clip'] as const
export type StudioAssetKind = typeof studioAssetKinds[number]
export type StudioFrameSlot = 'first' | 'last'
export interface StudioKeyframeOrigin {
  characterVersionId: string
  neutralAnchor?: true
  sceneVersionId?: string
}
export type StudioAssetSource =
  | { kind: 'file'; name?: string }
  | { kind: 'artwork'; artworkId: string | number }
  | { kind: 'catalog'; catalogKind: string; catalogId: string; catalogRevision?: number }
  | { kind: 'generation'; taskId: string; outputIndex: number; inputVersionIds: string[]; modelId?: string; prompt?: string; seed?: number; width?: number; height?: number; keyframe?: StudioKeyframeOrigin }

export interface StudioProject {
  id: string
  title: string
  revision: number
  workbench: Record<string, unknown> | null
}
export interface StudioShot {
  id: string
  projectId: string
  position: number
  title: string
  prompt: string
  revision: number
  firstVersionId: string | null
  lastVersionId: string | null
  audioVersionId?: string | null
  currentClipVersionId?: string | null
  legacy?: Record<string, unknown>
}
export interface StudioAsset { id: string; title: string; kind: StudioAssetKind; revision: number }
export interface StudioAssetVersion {
  id: string
  assetId: string
  number: number
  mediaAlias: string
  sha256: string
  mime: string
  bytes: number
  source: StudioAssetSource
}
export interface StudioProjectSnapshot {
  project: StudioProject
  shots: StudioShot[]
  assets: StudioAsset[]
  versions: StudioAssetVersion[]
}
