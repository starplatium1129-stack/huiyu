import type { DrawEngine, HistorySnapshot } from './promptHistory'

/** Actual completed request, kept as provenance; reusable scenes still compile anew. */
export interface GeneratedRecipe {
  version: 1
  engine: DrawEngine
  prompt: string
  negative: string
  parameters: HistorySnapshot
}
