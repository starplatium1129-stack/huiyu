/** 24 × 24 手绘单线轮廓；所有笔画由路径自身表达，不自动描重或填充。 */
export interface ArchiveIconDef {
  paths: string[]
}

/** Shared type-only vocabulary, independent of Vue's component compiler. */
export type ArchiveIconName = keyof (
  typeof import('./nav.ts').navDefs &
  typeof import('./status.ts').statusDefs &
  typeof import('./emotion.ts').emotionDefs &
  typeof import('./character.ts').characterDefs &
  typeof import('./camera.ts').cameraDefs &
  typeof import('./lighting.ts').lightingDefs &
  typeof import('./composition.ts').compositionDefs &
  typeof import('./motif.ts').motifDefs &
  typeof import('./tool.ts').toolDefs
)
